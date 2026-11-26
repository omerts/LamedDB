// Pre-merge gate for Qodo pull request findings.
// Reads JSON from `qodo read pr-review-session findings --pr-url <url> --extended --json`
// via --file, stdin, or by running that command for --pr-url.
// Exits 1 when a High or Medium finding is still open, 0 when none are, and 2 when
// the input or the qodo command cannot be evaluated. Does not change finding state.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_FINDINGS_JSON_BYTES = 20 * 1024 * 1024;
const QODO_TIMEOUT_MS = 120_000;
const SECRET_ENV = ["QODO_API_KEY", "QODO_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN"] as const;

const OPEN_STATUSES = new Set([
  "pending",
  "unresolved",
  "open",
  "partial_implementation",
  "not_implemented",
  "focus_areas_edited",
]);

const CLOSED_STATUSES = new Set([
  "implemented",
  "full_implementation",
  "resolved",
  "dismissed",
  "outdated",
  "found_after_merge",
  "detected_after_merge",
]);

const SEVERITY_BY_TOKEN: Readonly<Record<string, "High" | "Medium" | "Low">> = {
  high: "High",
  action_required: "High",
  medium: "Medium",
  remediation_recommended: "Medium",
  low: "Low",
  informational: "Low",
  info: "Low",
};

const USAGE = `Usage: npm run check:qodo-findings -- [--file <path> | --pr-url <url>]

Reads Qodo findings JSON and exits 1 when any High or Medium finding is open.
Exits 0 when no High or Medium finding is open. Exits 2 when the input or the qodo command cannot be used.

  --file <path>   JSON file from: qodo read pr-review-session findings --pr-url <url> --extended --json
  --pr-url <url>  Run that command and evaluate its JSON
  (no flag)       Read that JSON from stdin

Open includes pending, unresolved, and any status other than implemented, resolved, outdated, or found after merge.
Low findings do not block. This command does not dismiss findings or change severities.
`;

export interface FindingSummary {
  id: string;
  severity: string;
  category: string;
  title: string;
  file: string;
  status: string;
}

export type FindingsEvaluation =
  | { ok: true; lowOpen: number }
  | { ok: false; reason: "blocking"; blocking: FindingSummary[]; lowOpen: number }
  | { ok: false; reason: "invalid"; message: string };

export interface QodoRun {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}

export interface CheckIo {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  runQodo(prUrl: string): Promise<QodoRun>;
  stdinIsTTY: boolean;
  stdout(text: string): void;
  stderr(text: string): void;
}

type ParsedArgs =
  | { ok: true; mode: "help" }
  | { ok: true; mode: "stdin" }
  | { ok: true; mode: "file"; file: string }
  | { ok: true; mode: "pr-url"; prUrl: string }
  | { ok: false; message: string };

type Severity = "High" | "Medium" | "Low" | "unrecognized" | "(missing)";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value) as unknown;

  return proto === Object.prototype || proto === null;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function readStrings(
  record: Record<string, unknown>,
  keys: readonly string[],
): { kind: "values"; values: string[] } | { kind: "invalid" } {
  const values: string[] = [];

  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      continue;
    }

    const value = record[key];

    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value !== "string") {
      return { kind: "invalid" };
    }

    values.push(value);
  }

  return { kind: "values", values };
}

function firstText(values: readonly string[], fallback: string): string {
  for (const value of values) {
    const trimmed = value.trim();

    if (trimmed !== "") {
      return trimmed;
    }
  }

  return fallback;
}

function textField(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  index: number,
  fallback: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const read = readStrings(record, keys);

  if (read.kind === "invalid") {
    return { ok: false, message: `Finding at index ${index} has a ${label} that is not a string.` };
  }

  return { ok: true, value: firstText(read.values, fallback) };
}

function fileField(
  record: Record<string, unknown>,
  index: number,
): { ok: true; value: string } | { ok: false; message: string } {
  if (Object.hasOwn(record, "location") && record.location !== null && record.location !== undefined) {
    if (!isPlainObject(record.location)) {
      return { ok: false, message: `Finding at index ${index} has a location that is not an object.` };
    }

    const read = readStrings(record.location, ["file_path", "filePath"]);

    if (read.kind === "invalid") {
      return { ok: false, message: `Finding at index ${index} has a file path that is not a string.` };
    }

    const located = firstText(read.values, "");

    if (located !== "") {
      return { ok: true, value: located };
    }
  }

  return textField(record, ["file", "file_path", "filePath"], "file", index, "(no file)");
}

function classifySeverity(values: readonly string[]): Severity {
  if (values.length === 0) {
    return "(missing)";
  }

  let best: "High" | "Medium" | "Low" | null = null;
  let bestRank = -1;
  let unrecognized = false;
  const rank = { Low: 0, Medium: 1, High: 2 };

  for (const value of values) {
    const mapped = SEVERITY_BY_TOKEN[normalizeToken(value)];

    if (mapped === undefined) {
      unrecognized = true;
      continue;
    }

    if (rank[mapped] > bestRank) {
      best = mapped;
      bestRank = rank[mapped];
    }
  }

  if (unrecognized && best !== "High" && best !== "Medium") {
    return "unrecognized";
  }

  if (best === null) {
    return "unrecognized";
  }

  return best;
}

function classifyStatus(values: readonly string[]): { open: boolean; display: string } {
  if (values.length === 0) {
    return { open: true, display: "(missing)" };
  }

  let closed = "";
  let unknown = "";

  for (const value of values) {
    const token = normalizeToken(value);

    if (token === "") {
      return { open: true, display: "(missing)" };
    }

    if (OPEN_STATUSES.has(token)) {
      return { open: true, display: token };
    }

    if (CLOSED_STATUSES.has(token)) {
      if (closed === "") {
        closed = token;
      }

      continue;
    }

    unknown = token;
  }

  if (unknown !== "") {
    return { open: true, display: unknown };
  }

  if (closed !== "") {
    return { open: false, display: closed };
  }

  return { open: true, display: "(missing)" };
}

function findingsList(payload: unknown): { ok: true; findings: unknown[] } | { ok: false; message: string } {
  if (Array.isArray(payload)) {
    return { ok: true, findings: payload };
  }

  if (!isPlainObject(payload)) {
    return { ok: false, message: "Findings JSON must be a list or an object with a findings list." };
  }

  if (Object.hasOwn(payload, "qar_operation_result_truncated")) {
    const truncated = payload.qar_operation_result_truncated;

    if (truncated === true) {
      return {
        ok: false,
        message: "Findings list is truncated; cannot confirm every High or Medium finding.",
      };
    }

    if (truncated !== false && truncated !== null) {
      return { ok: false, message: "Findings JSON field qar_operation_result_truncated must be a boolean." };
    }
  }

  if (!Object.hasOwn(payload, "findings") || payload.findings === null || !Array.isArray(payload.findings)) {
    return { ok: false, message: "Findings JSON must be a list or an object with a findings list." };
  }

  return { ok: true, findings: payload.findings };
}

function parseFinding(
  value: unknown,
  index: number,
): { ok: true; summary: FindingSummary; blocks: boolean; lowOpen: boolean } | { ok: false; message: string } {
  if (!isPlainObject(value)) {
    return { ok: false, message: `Finding at index ${index} is not an object.` };
  }

  const id = textField(value, ["id"], "id", index, "(no id)");

  if (!id.ok) {
    return id;
  }

  const category = textField(value, ["category"], "category", index, "(no category)");

  if (!category.ok) {
    return category;
  }

  const title = textField(value, ["title"], "title", index, "(no title)");

  if (!title.ok) {
    return title;
  }

  const file = fileField(value, index);

  if (!file.ok) {
    return file;
  }

  const severities = readStrings(value, ["severity", "action_level", "actionLevel"]);

  if (severities.kind === "invalid") {
    return { ok: false, message: `Finding at index ${index} has a severity that is not a string.` };
  }

  const statuses = readStrings(value, ["status", "attribution_status", "attributionStatus"]);

  if (statuses.kind === "invalid") {
    return { ok: false, message: `Finding at index ${index} has a status that is not a string.` };
  }

  const severity = classifySeverity(severities.values);
  const status = classifyStatus(statuses.values);
  const blocks = status.open && severity !== "Low";

  return {
    ok: true,
    blocks,
    lowOpen: status.open && severity === "Low",
    summary: {
      id: id.value,
      severity,
      category: category.value,
      title: title.value,
      file: file.value,
      status: status.display,
    },
  };
}

export function parseFindingsJson(
  text: string,
  maxBytes = MAX_FINDINGS_JSON_BYTES,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, message: "Findings JSON exceeds the size limit." };
  }

  const trimmed = text.replace(/^\uFEFF/, "").trim();

  if (trimmed === "") {
    return { ok: false, message: "Findings JSON is empty." };
  }

  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false, message: "Findings JSON is not valid JSON." };
  }
}

// Review completion stays on the existing readiness gate. This check only
// decides whether a High or Medium finding in the supplied list is still open.
export function evaluateFindings(payload: unknown): FindingsEvaluation {
  const listed = findingsList(payload);

  if (!listed.ok) {
    return { ok: false, reason: "invalid", message: listed.message };
  }

  const blocking: FindingSummary[] = [];
  let lowOpen = 0;

  for (let index = 0; index < listed.findings.length; index += 1) {
    const parsed = parseFinding(listed.findings[index], index);

    if (!parsed.ok) {
      return { ok: false, reason: "invalid", message: parsed.message };
    }

    if (parsed.blocks) {
      blocking.push(parsed.summary);
      continue;
    }

    if (parsed.lowOpen) {
      lowOpen += 1;
    }
  }

  if (blocking.length > 0) {
    return { ok: false, reason: "blocking", blocking, lowOpen };
  }

  return { ok: true, lowOpen };
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function formatFinding(finding: FindingSummary): string {
  return `- id=${quoted(finding.id)} severity=${finding.severity} category=${quoted(finding.category)} title=${quoted(finding.title)} file=${quoted(finding.file)} status=${quoted(finding.status)}`;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;

  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }

    redacted = redacted.split(secret).join("[redacted]");
  }

  redacted = redacted.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  redacted = redacted.replace(/\b(?:ghp_|github_pat_|qodo_)[A-Za-z0-9_]+/g, "[redacted]");

  return redacted;
}

function envSecrets(): string[] {
  const secrets: string[] = [];

  for (const name of SECRET_ENV) {
    const value = process.env[name];

    if (typeof value === "string" && value.length > 0) {
      secrets.push(value);
    }
  }

  return secrets;
}

function write(sink: (text: string) => void, text: string): void {
  sink(`${redactSecrets(text, envSecrets())}\n`);
}

function report(evaluation: FindingsEvaluation, io: CheckIo): number {
  if (!evaluation.ok) {
    if (evaluation.reason === "invalid") {
      write(io.stderr, `Qodo findings check failed. ${evaluation.message}`);

      return 2;
    }

    const noun = evaluation.blocking.length === 1 ? "finding" : "findings";
    const lines = [
      `Qodo findings check failed. ${evaluation.blocking.length} open High or Medium ${noun}:`,
      ...evaluation.blocking.map(formatFinding),
    ];

    write(io.stderr, lines.join("\n"));

    return 1;
  }

  let message = "Qodo findings check passed. No open High or Medium findings.";

  if (evaluation.lowOpen > 0) {
    const noun = evaluation.lowOpen === 1 ? "finding does" : "findings do";

    message += ` ${evaluation.lowOpen} open Low ${noun} not block.`;
  }

  write(io.stdout, message);

  return 0;
}

function validPrUrl(value: string): boolean {
  if (value.trim() === "" || /\s/u.test(value)) {
    return false;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }

  return url.username === "" && url.password === "";
}

function takeValue(argv: readonly string[], index: number, flag: string): { ok: true; value: string; next: number } | { ok: false; message: string } {
  const current = argv[index];

  if (current === undefined) {
    return { ok: false, message: `${flag} needs a value.` };
  }

  const inline = `${flag}=`;

  if (current.startsWith(inline)) {
    const value = current.slice(inline.length);

    if (value === "") {
      return { ok: false, message: `${flag} needs a value.` };
    }

    return { ok: true, value, next: index };
  }

  const value = argv[index + 1];

  if (value === undefined || value.startsWith("--")) {
    return { ok: false, message: `${flag} needs a value.` };
  }

  return { ok: true, value, next: index + 1 };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let file: string | null = null;
  let prUrl: string | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--file" || arg.startsWith("--file=")) {
      if (file !== null) {
        return { ok: false, message: "--file was given more than once." };
      }

      const taken = takeValue(argv, index, "--file");

      if (!taken.ok) {
        return { ok: false, message: "--file needs a path." };
      }

      file = taken.value;
      index = taken.next;
      continue;
    }

    if (arg === "--pr-url" || arg.startsWith("--pr-url=")) {
      if (prUrl !== null) {
        return { ok: false, message: "--pr-url was given more than once." };
      }

      const taken = takeValue(argv, index, "--pr-url");

      if (!taken.ok) {
        return { ok: false, message: "--pr-url needs a pull request URL." };
      }

      if (!validPrUrl(taken.value)) {
        return { ok: false, message: "--pr-url must be an http(s) URL without credentials." };
      }

      prUrl = taken.value;
      index = taken.next;
      continue;
    }

    return { ok: false, message: `Unknown argument ${quoted(arg)}.` };
  }

  if (help) {
    if (file !== null || prUrl !== null || argv.length !== 1) {
      return { ok: false, message: "--help does not take other arguments." };
    }

    return { ok: true, mode: "help" };
  }

  if (file !== null && prUrl !== null) {
    return { ok: false, message: "Pass only one of --file or --pr-url." };
  }

  if (file !== null) {
    return { ok: true, mode: "file", file };
  }

  if (prUrl !== null) {
    return { ok: true, mode: "pr-url", prUrl };
  }

  return { ok: true, mode: "stdin" };
}

export function qodoFindingsArgs(prUrl: string): string[] {
  return ["read", "pr-review-session", "findings", "--pr-url", prUrl, "--extended", "--json"];
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBytes: number },
): Promise<QodoRun> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    const finish = (result: QodoRun) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      resolve(result);
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        status: 124,
        stdout: "",
        stderr: "qodo findings command timed out.",
        timedOut: true,
        overflow: false,
      });
    }, options.timeoutMs);

    const capture = (target: Buffer[], chunk: Buffer | string) => {
      if (overflow || settled) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      bytes += buffer.length;

      if (bytes > options.maxBytes) {
        overflow = true;
        stdout.length = 0;
        stderr.length = 0;
        child.kill("SIGKILL");
        finish({
          status: 1,
          stdout: "",
          stderr: "Findings output exceeded the size limit.",
          timedOut: false,
          overflow: true,
        });

        return;
      }

      target.push(buffer);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      capture(stderr, chunk);
    });
    child.on("error", (error: Error) => {
      finish({ status: 127, stdout: "", stderr: error.message, timedOut: false, overflow: false });
    });
    child.on("close", (code) => {
      finish({
        status: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: false,
        overflow: false,
      });
    });
  });
}

function qodoCommand(): string | null {
  const configured = process.env.QODO_BIN;

  if (configured === undefined) {
    return "qodo";
  }

  if (configured.trim() === "" || configured.includes("\0")) {
    return null;
  }

  return configured;
}

export function runQodoFindings(prUrl: string): Promise<QodoRun> {
  const command = qodoCommand();

  if (command === null) {
    return Promise.resolve({
      status: 127,
      stdout: "",
      stderr: "QODO_BIN is invalid.",
      timedOut: false,
      overflow: false,
    });
  }

  return runProcess(command, qodoFindingsArgs(prUrl), {
    timeoutMs: QODO_TIMEOUT_MS,
    maxBytes: MAX_FINDINGS_JSON_BYTES,
  });
}

function readErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "error";
  }

  const code = error.code;

  if (typeof code !== "string" || code === "") {
    return "error";
  }

  return code;
}

function commandFailure(run: QodoRun, io: CheckIo): number {
  if (run.timedOut) {
    write(io.stderr, "Qodo findings check failed. qodo findings command timed out.");

    return 2;
  }

  if (run.overflow) {
    write(io.stderr, "Qodo findings check failed. Findings output exceeded the size limit.");

    return 2;
  }

  const detail = redactSecrets(run.stderr || run.stdout, envSecrets()).trim().split("\n").slice(0, 20).join("\n");
  let message = `Qodo findings check failed. qodo exited ${run.status}.`;

  if (detail !== "") {
    message += `\n${detail}`;
  }

  write(io.stderr, message);

  return 2;
}

export async function checkFindings(argv: readonly string[], io: CheckIo): Promise<number> {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    write(io.stderr, `Qodo findings check failed. ${parsed.message}`);

    return 2;
  }

  if (parsed.mode === "help") {
    io.stdout(USAGE);

    return 0;
  }

  if (parsed.mode === "pr-url") {
    const run = await io.runQodo(parsed.prUrl);

    if (run.timedOut || run.overflow || run.status !== 0) {
      return commandFailure(run, io);
    }

    const json = parseFindingsJson(run.stdout);

    if (!json.ok) {
      write(io.stderr, `Qodo findings check failed. ${json.message}`);

      return 2;
    }

    return report(evaluateFindings(json.value), io);
  }

  if (parsed.mode === "stdin" && io.stdinIsTTY) {
    write(io.stderr, `Qodo findings check failed. Pass --file, --pr-url, or pipe findings JSON on stdin.\n\n${USAGE.trimEnd()}`);

    return 2;
  }

  let text: string;

  if (parsed.mode === "file") {
    try {
      text = await io.readFile(parsed.file);
    } catch (error) {
      write(io.stderr, `Qodo findings check failed. Cannot read findings file ${quoted(parsed.file)} (${readErrorCode(error)}).`);

      return 2;
    }
  } else {
    text = await io.readStdin();
  }

  const json = parseFindingsJson(text);

  if (!json.ok) {
    write(io.stderr, `Qodo findings check failed. ${json.message}`);

    return 2;
  }

  return report(evaluateFindings(json.value), io);
}

function isDirectRun(): boolean {
  const arg = process.argv[1];

  if (!arg) {
    return false;
  }

  try {
    if (import.meta.url === pathToFileURL(realpathSync(arg)).href) {
      return true;
    }
  } catch {
    return arg.endsWith("check-qodo-findings.ts");
  }

  return arg.endsWith("check-qodo-findings.ts");
}

function createDefaultIo(): CheckIo {
  return {
    readFile(file) {
      return readFile(file, "utf8");
    },
    async readStdin() {
      const chunks: Buffer[] = [];

      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }

      return Buffer.concat(chunks).toString("utf8");
    },
    runQodo: runQodoFindings,
    stdinIsTTY: process.stdin.isTTY === true,
    stdout(text) {
      process.stdout.write(text);
    },
    stderr(text) {
      process.stderr.write(text);
    },
  };
}

if (isDirectRun()) {
  const code = await checkFindings(process.argv.slice(2), createDefaultIo());

  process.exit(code);
}

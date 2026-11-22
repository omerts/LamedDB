#!/usr/bin/env node
// api-behavior-check runner. Node >= 20, no dependencies.
// Usage: node .cursor/skills/api-behavior-check/scripts/check.mjs <cases.json> [--out DIR] [--base-url URL] [--key KEY]
// Exit codes: 0 all PASS | 1 at least one FAIL | 2 NEEDS INPUT (stop and ask) | 3 setup error
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The cases run owns this process. Every exit path kills it, including timeouts and crashes.
let child;

process.on("exit", () => {
  stopChild();
});

export function stopChild(proc = child) {
  if (proc == null || proc.exitCode !== null || proc.signalCode !== null || proc.killed) {
    return;
  }

  try {
    proc.kill();
  } catch {
    // Already reaped. Exiting still has to finish.
  }
}

export function portFor(url) {
  if (url.port !== "") {
    return Number(url.port);
  }

  return url.protocol === "https:" ? 443 : 80;
}

// A cases file may only tune LamedDB. The runner sets the bind address and the API key.
export const CASE_ENV_ALLOWLIST = ["IDEMPOTENCY_TTL_MS", "IDEMPOTENCY_MAX_KEYS"];

export function repoRoot() {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

export function repoServerEntry() {
  return join(repoRoot(), "dist", "cli.js");
}

export function caseProcessProblems(spec) {
  const problems = [];

  if (spec != null && Object.prototype.hasOwnProperty.call(spec, "serverEntry")) {
    problems.push("serverEntry is not allowed. The runner always starts dist/cli.js from the repo root.");
  }

  if (spec != null && Object.prototype.hasOwnProperty.call(spec, "env")) {
    const env = spec.env;

    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      problems.push("env must be an object of LamedDB settings.");
    } else {
      for (const key of Object.keys(env)) {
        if (!CASE_ENV_ALLOWLIST.includes(key)) {
          problems.push(`env.${key} is not allowed. Allowed: ${CASE_ENV_ALLOWLIST.join(", ")}.`);
        } else if (typeof env[key] !== "string") {
          problems.push(`env.${key} must be a string.`);
        }
      }
    }
  }

  return problems;
}

// Only allowlisted settings are copied. HOST, PORT, and the API key stay the runner's.
export function serverEnv(base, specEnv, forced) {
  const allowed = {};

  if (specEnv != null && typeof specEnv === "object" && !Array.isArray(specEnv)) {
    for (const key of CASE_ENV_ALLOWLIST) {
      if (typeof specEnv[key] === "string") {
        allowed[key] = specEnv[key];
      }
    }
  }

  return {
    ...base,
    ...allowed,
    PORT: String(forced.port),
    HOST: forced.host,
    LAMEDDB_API_KEYS: forced.key,
  };
}

export function parseHttpResponse(raw) {
  let buf = typeof raw === "string" ? raw : raw.toString("utf8");

  while (buf.length > 0) {
    const sep = buf.indexOf("\r\n\r\n");

    if (sep < 0) {
      throw new Error("no HTTP response (connection closed). raw=" + JSON.stringify(buf.slice(0, 200)));
    }

    const head = buf.slice(0, sep);
    const rest = buf.slice(sep + 4);
    const [statusLine, ...headerLines] = head.split("\r\n");

    if (!statusLine) {
      throw new Error("no HTTP response (connection closed). raw=" + JSON.stringify(buf.slice(0, 200)));
    }

    const status = Number(statusLine.split(" ")[1]);
    const headers = Object.fromEntries(
      headerLines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]),
    );

    // 1xx (100 Continue, 103 Early Hints, ...) has no body. The final response follows.
    if (status >= 100 && status < 200) {
      buf = rest;
      continue;
    }

    let text = rest;

    if (headers["transfer-encoding"] === "chunked") {
      text = decodeChunked(text);
    }

    return { status, headers, text };
  }

  throw new Error("no HTTP response (connection closed). raw=" + JSON.stringify(String(raw).slice(0, 200)));
}

// Reasons for one case. An actual error status always has to be the standard error envelope, even when a 2xx was also allowed.
export function judgeCase(c, r, err, serverLog) {
  const reasons = [];
  let needsInput = false;
  let json;

  if (r) {
    try {
      json = JSON.parse(r.text);
    } catch {
      json = undefined;
    }
  }

  const want = [].concat(c.expect.status);

  if (err) {
    reasons.push(`no response: ${err}`);

    return { reasons, needsInput, want };
  }

  if (!want.includes(r.status)) {
    reasons.push(`status ${r.status}, want ${want.join(" or ")}`);
  }

  for (const [p, v] of Object.entries(c.expect.body ?? {})) {
    const got = getPath(json, p);
    const ok = v === "*" ? got !== undefined : v === null ? got === undefined : Array.isArray(v) ? v.includes(got) : got === v;

    if (!ok) {
      reasons.push(`body.${p} = ${JSON.stringify(got)}, want ${JSON.stringify(v)}`);
    }
  }

  if ((c.expect.errorShape || r.status >= 400) && !isErrorEnvelope(json)) {
    reasons.push('body is not {"error":{"code","message"}}');
  }

  for (const pattern of c.expect.serverLogMustNotMatch ?? []) {
    if (new RegExp(pattern, "i").test(serverLog)) {
      reasons.push(`server log matched /${pattern}/: ${serverLog.trim().split("\n")[0]}`);
    }
  }

  if ((r.status === 404 || r.status === 405) && !want.includes(r.status) && json?.error?.code !== "internal" && !c.expect.allowNotFound) {
    needsInput = true;
    reasons.push(`ENDPOINT NOT FOUND/ALLOWED (${r.status}); confirm path/method with the user`);
  }

  return { reasons, needsInput, want };
}

async function main() {
  const args = process.argv.slice(2);
  const casesFile = args[0];
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

  if (!casesFile) {
    die(3, "usage: check.mjs <cases.json> [--out DIR] [--base-url URL] [--key KEY]");
  }

  const spec = JSON.parse(readFileSync(casesFile, "utf8"));
  const outDir = resolve(opt("--out") ?? join("evidence", `${spec.name ?? "check"}-${Date.now()}`));
  mkdirSync(outDir, { recursive: true });

  // ---- 1. Refuse to run when the ticket left something unspecified
  const missing = [];

  for (const c of spec.cases ?? []) {
    const e = c.expect ?? {};

    if (!c.id || (!c.path && !c.rawTarget)) {
      missing.push(`${c.id ?? "?"}: needs id and path or rawTarget`);
    }

    if (e.status === undefined || e.status === null || (Array.isArray(e.status) && e.status.length === 0)) {
      missing.push(`${c.id}: ticket gives no expected status`);
    }

    if (Number(e.status) >= 400 || (Array.isArray(e.status) && e.status.every((s) => s >= 400))) {
      if (!e.body || Object.keys(e.body).length === 0) {
        missing.push(`${c.id}: error case has no expected body fields (e.g. {"error.code":"..."})`);
      }
    }
  }

  if (!spec.cases?.length) {
    missing.push("no cases");
  }

  const refused = caseProcessProblems(spec);

  if (missing.length || refused.length) {
    if (missing.length) {
      console.log("NEEDS INPUT - stop and ask the user before running:\n" + missing.map((m) => " - " + m).join("\n"));
      writeFileSync(join(outDir, "needs-input.txt"), missing.join("\n") + "\n");
    }

    if (refused.length) {
      console.error("REFUSED - the cases file must not control the server process:\n" + refused.map((m) => " - " + m).join("\n"));
      writeFileSync(join(outDir, "refused.txt"), refused.join("\n") + "\n");
    }

    finish(2);
  }

  // ---- 2. Server: fresh process, fresh in-memory store (LamedDB has no data dir yet)
  const key = opt("--key") ?? `chk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  let base = opt("--base-url");
  let logs = "";

  if (!base) {
    const entry = repoServerEntry();

    if (!existsSync(entry)) {
      die(3, `${entry} not found. Run: npm ci && npm run build`);
    }

    const port = await freePort();
    child = spawn(process.execPath, [entry], {
      cwd: repoRoot(),
      env: serverEnv(process.env, spec.env, { port, host: "127.0.0.1", key }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      logs += d;
    });
    child.stderr.on("data", (d) => {
      logs += d;
    });
    base = `http://127.0.0.1:${port}`;
    const attempts = Number(process.env.CHECK_START_ATTEMPTS) || 100;

    for (let i = 0; ; i++) {
      if (child.exitCode !== null) {
        die(3, "server exited early:\n" + logs);
      }

      if (i > attempts) {
        die(3, "server did not start in 10s:\n" + logs);
      }

      try {
        await fetch(base + "/health");
        break;
      } catch {
        await sleep(100);
      }
    }
  }

  const u = new URL(base);
  const sub = (v) => (typeof v === "string" ? v.replaceAll("${KEY}", key) : v);

  // ---- 3. HTTP helpers
  async function send(c) {
    const headers = { ...(c.headers ?? {}) };
    const auth = c.auth ?? "valid"; // valid | none | any literal header value

    if (auth === "valid") {
      headers.authorization = `Bearer ${key}`;
    } else if (auth !== "none") {
      headers.authorization = sub(auth);
    }

    for (const name of Object.keys(headers)) {
      headers[name] = sub(headers[name]);
    }

    let body = c.body === undefined ? undefined : typeof c.body === "string" ? c.body : JSON.stringify(c.body);

    if (body !== undefined && !Object.keys(headers).some((header) => header.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }

    const method = c.method ?? "GET";
    const target = c.rawTarget ?? c.path;

    // Raw socket so malformed request targets reach the server unchanged.
    return await new Promise((res, rej) => {
      const sock = connect(portFor(u), u.hostname);
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        sock.destroy();
        rej(new Error("timeout"));
      }, 8000);
      sock.on("connect", () => {
        let head = `${method} ${target} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n`;

        for (const [name, value] of Object.entries(headers)) {
          head += `${name}: ${value}\r\n`;
        }

        if (body !== undefined) {
          head += `content-length: ${Buffer.byteLength(body)}\r\n`;
        }

        sock.write(head + "\r\n" + (body ?? ""));
      });
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
      });
      sock.on("error", rej);
      sock.on("close", () => {
        clearTimeout(timer);

        try {
          res(parseHttpResponse(buf.toString("utf8")));
        } catch (error) {
          rej(error);
        }
      });
    });
  }

  // ---- 4. Fixture (must succeed or we stop: a wrong fixture makes every result meaningless)
  const transcript = [];

  for (const f of spec.fixture ?? []) {
    const r = await send({ ...f, auth: f.auth ?? "valid" });
    transcript.push({ phase: "fixture", request: show(f), status: r.status, body: r.text });
    const want = f.expectStatus ?? [200, 201, 204];

    if (!want.includes(r.status)) {
      die(3, `fixture step failed: ${f.method} ${f.path} -> ${r.status} ${r.text}`);
    }
  }

  // ---- 5. Cases
  const rows = [];
  let needsInput = false;

  for (const c of spec.cases) {
    const logStart = logs.length;
    let r;
    let err;

    try {
      r = await send(c);
    } catch (e) {
      err = String(e.message ?? e);
    }

    await sleep(50);
    const newLogs = logs.slice(logStart);
    const judged = judgeCase(c, r, err, newLogs);

    if (judged.needsInput) {
      needsInput = true;
    }

    rows.push({
      id: c.id,
      criterion: c.criterion ?? "",
      desc: c.desc ?? "",
      request: show(c),
      want: judged.want.join("|") + (c.expect.body ? " " + JSON.stringify(c.expect.body) : ""),
      got: r ? `${r.status} ${r.text.slice(0, 160)}` : "-",
      result: judged.reasons.length ? "FAIL" : "PASS",
      reasons: judged.reasons,
    });
    transcript.push({
      phase: "case",
      id: c.id,
      request: show(c),
      status: r?.status,
      headers: r?.headers,
      body: r?.text,
      serverLog: newLogs.trim() || undefined,
      result: judged.reasons.length ? "FAIL" : "PASS",
      reasons: judged.reasons,
    });
  }

  stopChild();

  // ---- 6. Report + evidence
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  let table = `${pad("ID", 12)} ${pad("RESULT", 6)} ${pad("REQUEST", 44)} ${pad("EXPECTED", 38)} GOT\n`;

  for (const x of rows) {
    table += `${pad(x.id, 12)} ${pad(x.result, 6)} ${pad(x.request, 44)} ${pad(x.want, 38)} ${x.got.replace(/\s+/g, " ").slice(0, 70)}\n`;
  }

  const fails = rows.filter((x) => x.result === "FAIL");
  table += `\n${rows.length - fails.length}/${rows.length} PASS\n` + fails.map((x) => `FAIL ${x.id}: ${x.reasons.join("; ")}`).join("\n") + (fails.length ? "\n" : "");
  console.log(table);
  const md =
    `# ${spec.name ?? "API behavior check"}\n\nTicket: ${spec.ticket ?? "n/a"}\nCommit: ${process.env.CHECK_COMMIT ?? "(set CHECK_COMMIT)"}\nRun: ${new Date().toISOString()}\n\n| ID | Criterion | Request | Expected | Got | Result |\n|---|---|---|---|---|---|\n` +
    rows.map((x) => `| ${x.id} | ${x.criterion} | \`${x.request}\` | ${esc(x.want)} | ${esc(x.got.replace(/\s+/g, " "))} | **${x.result}** |`).join("\n") +
    "\n" +
    fails.map((x) => `\n- FAIL ${x.id}: ${x.reasons.join("; ")}`).join("") +
    "\n";
  writeFileSync(join(outDir, "results.md"), md);
  writeFileSync(join(outDir, "transcript.json"), JSON.stringify(transcript, null, 2).replaceAll(key, "<KEY>"));
  writeFileSync(join(outDir, "table.txt"), table);
  console.log(`evidence: ${outDir}/{table.txt,results.md,transcript.json}`);
  finish(needsInput ? 2 : fails.length ? 1 : 0);
}

function isErrorEnvelope(json) {
  return Boolean(json) && typeof json.error?.code === "string" && typeof json.error?.message === "string";
}

function decodeChunked(text) {
  let out = "";
  let rest = text;

  while (rest) {
    const n = rest.indexOf("\r\n");
    const len = parseInt(rest.slice(0, n), 16);

    if (!len) {
      break;
    }

    out += rest.slice(n + 2, n + 2 + len);
    rest = rest.slice(n + 2 + len + 2);
  }

  return out;
}

function getPath(o, p) {
  return p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
}

function show(c) {
  return `${c.method ?? "GET"} ${c.rawTarget ?? c.path}${c.auth === "none" ? " (no key)" : ""}`;
}

function esc(s) {
  return String(s).replaceAll("|", "\\|");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function die(code, msg) {
  console.error(msg);
  finish(code);
}

function finish(code) {
  stopChild();
  process.exit(code);
}

function freePort() {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}

function isDirectRun() {
  const entry = process.argv[1];

  if (!entry) {
    return false;
  }

  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  try {
    await main();
  } catch (error) {
    die(3, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkFindings,
  evaluateFindings,
  InputTooLargeError,
  parseFindingsJson,
  readStreamAtMost,
  qodoFindingsArgs,
  redactSecrets,
  runProcess,
  runQodoFindings,
  type CheckIo,
  type QodoRun,
} from "../scripts/check-qodo-findings.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const PR42 = {
  review_session: { status: "completed", commit_sha: "3399c01faad94aac9df6eb781e2c0940d0770757" },
  findings: [
    {
      id: "adf211b2-b617-4ec0-b535-6a395dd237fa",
      title: "Declared fields silently disappear",
      category: "Bug",
      action_level: "action_required",
      attribution_status: "pending",
      location: { file_path: "src/storage/postgres-store.ts", start_line: 871 },
    },
    {
      id: "84b4c1be-ff61-4fea-9ee7-8182efaa30bb",
      title: "Keyed writes slow as stored keys grow",
      category: "Bug",
      action_level: "remediation_recommended",
      attribution_status: "pending",
      location: { file_path: "src/storage/postgres-store.ts" },
    },
    {
      id: "d1ee3490-8868-4597-9ada-b0db1f9499fe",
      title: "Valid records containing NUL fail to save",
      category: "Bug",
      action_level: "remediation_recommended",
      attribution_status: "pending",
      description: "jsonb rejects NUL",
      location: { file_path: "src/validate.ts" },
    },
  ],
};

function io(overrides: {
  readFile?: CheckIo["readFile"];
  readStdin?: CheckIo["readStdin"];
  runQodo?: CheckIo["runQodo"];
  stdinIsTTY?: boolean;
} = {}): { io: CheckIo; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const input: CheckIo = {
    readFile: overrides.readFile ?? (async () => {
      throw Object.assign(new Error("missing file"), { code: "ENOENT" });
    }),
    readStdin: overrides.readStdin ?? (async () => ""),
    runQodo: overrides.runQodo ?? (async () => ({
      status: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      overflow: false,
    })),
    stdinIsTTY: overrides.stdinIsTTY ?? false,
    stdout(text) {
      out.push(text);
    },
    stderr(text) {
      err.push(text);
    },
  };

  return { io: input, stdout: () => out.join(""), stderr: () => err.join("") };
}

function qodoRun(overrides: Partial<QodoRun> = {}): QodoRun {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    overflow: false,
    ...overrides,
  };
}

describe("evaluateFindings", () => {
  it("blocks on the open High and Medium findings from PR #42", () => {
    const result = evaluateFindings(PR42);

    expect(result.ok).toBe(false);

    if (result.ok || result.reason !== "blocking") {
      throw new Error("expected blocking findings");
    }

    expect(result.blocking.map((finding) => [finding.id, finding.severity, finding.category, finding.title, finding.file])).toEqual([
      ["adf211b2-b617-4ec0-b535-6a395dd237fa", "High", "Bug", "Declared fields silently disappear", "src/storage/postgres-store.ts"],
      ["84b4c1be-ff61-4fea-9ee7-8182efaa30bb", "Medium", "Bug", "Keyed writes slow as stored keys grow", "src/storage/postgres-store.ts"],
      ["d1ee3490-8868-4597-9ada-b0db1f9499fe", "Medium", "Bug", "Valid records containing NUL fail to save", "src/validate.ts"],
    ]);
  });

  it("passes when every High and Medium finding is implemented, as on PR #40", () => {
    const result = evaluateFindings({
      findings: [
        { id: "high-1", severity: "High", category: "Bug", title: "Fixed high", file: "src/engine/router.ts", status: "implemented" },
        { id: "med-1", action_level: "remediation_recommended", category: "Rule violation", title: "Fixed medium", attribution_status: "implemented", location: { file_path: "src/engine/catalog.ts" } },
        { id: "low-1", action_level: "informational", title: "Style note", attribution_status: "pending", location: { file_path: "README.md" } },
      ],
    });

    expect(result).toEqual({ ok: true, lowOpen: 1 });
  });

  it("passes when the only open finding is Low or the list is empty", () => {
    expect(evaluateFindings({ findings: [{ id: "low", severity: "Low", status: "pending", title: "Nit", category: "Style", file: "AGENTS.md" }] })).toEqual({
      ok: true,
      lowOpen: 1,
    });
    expect(evaluateFindings({ findings: [] })).toEqual({ ok: true, lowOpen: 0 });
    expect(evaluateFindings([])).toEqual({ ok: true, lowOpen: 0 });
  });

  it("does not block implemented, resolved, outdated, or found-after-merge findings", () => {
    const statuses = ["implemented", "resolved", "outdated", "found-after-merge", "found after merge", "detected_after_merge", "full_implementation", "dismissed"];

    for (const status of statuses) {
      expect(evaluateFindings({
        findings: [
          { id: `high-${status}`, severity: "High", status, title: "Closed high", category: "Bug", file: "src/cli.ts" },
          { id: `med-${status}`, severity: "Medium", attribution_status: status, title: "Closed medium", category: "Bug", file: "src/cli.ts" },
        ],
      }), status).toEqual({ ok: true, lowOpen: 0 });
    }
  });

  it("treats unresolved open statuses as blocking for High and Medium", () => {
    const statuses = ["pending", "open", "unresolved", "partial-implementation", "not_implemented", "focus_areas_edited", "still_open"];

    for (const status of statuses) {
      const result = evaluateFindings({
        findings: [{ id: status, severity: status === "pending" ? "high" : "Medium", status, title: "Open", category: "Bug", file: "src/cli.ts" }],
      });

      expect(result.ok, status).toBe(false);

      if (result.ok || result.reason !== "blocking") {
        throw new Error(`expected ${status} to block`);
      }

      expect(result.blocking[0]?.severity).toBe(status === "pending" ? "High" : "Medium");
      expect(result.blocking[0]?.status).toBe(status.replace(/[\s-]+/g, "_"));
    }
  });

  it("keeps the higher severity when both severity fields are present", () => {
    const lowered = evaluateFindings({
      findings: [{ id: "1", severity: "Low", action_level: "action_required", status: "pending", title: "Do not lower", category: "Bug", file: "src/cli.ts" }],
    });

    expect(lowered.ok).toBe(false);

    if (!lowered.ok && lowered.reason === "blocking") {
      expect(lowered.blocking[0]?.severity).toBe("High");
    }
  });

  it("blocks an open finding whose severity is missing or unrecognized", () => {
    const missing = evaluateFindings({ findings: [{ id: "1", status: "pending", title: "No severity", category: "Bug", file: "src/cli.ts" }] });
    const unknown = evaluateFindings({ findings: [{ id: "2", severity: "critical", status: "pending", title: "Unknown", category: "Bug", file: "src/cli.ts" }] });
    const closedUnknown = evaluateFindings({ findings: [{ id: "3", severity: "critical", status: "implemented", title: "Closed", category: "Bug", file: "src/cli.ts" }] });

    expect(missing.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    expect(closedUnknown).toEqual({ ok: true, lowOpen: 0 });
  });

  it("rejects a truncated or malformed findings document", () => {
    expect(evaluateFindings({ findings: [], qar_operation_result_truncated: true })).toEqual({
      ok: false,
      reason: "invalid",
      message: "Findings list is truncated; cannot confirm every High or Medium finding.",
    });
    expect(evaluateFindings({ review_session: null }).ok).toBe(false);
    expect(evaluateFindings({ findings: [null] })).toMatchObject({ ok: false, reason: "invalid" });
    expect(evaluateFindings({ findings: [{ id: "1", severity: 1, status: "pending" }] })).toMatchObject({
      ok: false,
      message: "Finding at index 0 has a severity that is not a string.",
    });
  });
});

describe("checkFindings", () => {
  it("exits 1 and prints each blocking finding from PR #42", async () => {
    const captured = io({ readStdin: async () => JSON.stringify(PR42) });
    const code = await checkFindings([], captured.io);

    expect(code).toBe(1);
    expect(captured.stderr()).toContain("3 open High or Medium findings");
    expect(captured.stderr()).toContain("adf211b2-b617-4ec0-b535-6a395dd237fa");
    expect(captured.stderr()).toContain("severity=High");
    expect(captured.stderr()).toContain("84b4c1be-ff61-4fea-9ee7-8182efaa30bb");
    expect(captured.stderr()).toContain("d1ee3490-8868-4597-9ada-b0db1f9499fe");
    expect(captured.stderr()).toContain("src/validate.ts");
    expect(captured.stdout()).toBe("");
  });

  it("exits 0 when High and Medium findings are implemented", async () => {
    const captured = io({
      readFile: async () => JSON.stringify({
        findings: [
          { id: "high-1", severity: "High", status: "implemented", title: "Fixed", category: "Bug", file: "src/engine/router.ts" },
          { id: "med-1", severity: "Medium", status: "outdated", title: "Old", category: "Bug", file: "src/engine/router.ts" },
        ],
      }),
    });
    const code = await checkFindings(["--file", "findings.json"], captured.io);

    expect(code).toBe(0);
    expect(captured.stdout()).toContain("No open High or Medium findings");
  });

  it("exits 0 for an empty list and for a pending Low finding", async () => {
    const empty = io({ readStdin: async () => "[]" });
    const low = io({
      readStdin: async () => JSON.stringify({
        findings: [{ id: "low", action_level: "informational", attribution_status: "pending", title: "Nit", category: "Style", location: { file_path: "README.md" } }],
      }),
    });

    expect(await checkFindings([], empty.io)).toBe(0);
    expect(await checkFindings([], low.io)).toBe(0);
    expect(low.stdout()).toContain("1 open Low finding does not block");
  });

  it("prints usage for --help and rejects an unknown argument", async () => {
    const help = io();
    const unknown = io();

    expect(await checkFindings(["--help"], help.io)).toBe(0);
    expect(help.stdout()).toContain("Usage:");
    expect(await checkFindings(["--nope"], unknown.io)).toBe(2);
    expect(unknown.stderr()).toContain("Unknown argument");
  });

  it("exits 2 on malformed JSON without throwing", async () => {
    const captured = io({ readStdin: async () => "{not json" });
    const code = await checkFindings([], captured.io);

    expect(code).toBe(2);
    expect(captured.stderr()).toContain("Findings JSON is not valid JSON.");
    expect(captured.stderr()).not.toContain("{not json");
  });

  it("reads --file, stdin, and --pr-url JSON", async () => {
    const urls: string[] = [];
    const fromFile = io({ readFile: async () => "{\"findings\":[]}" });
    const fromUrl = io({
      runQodo: async (prUrl) => {
        urls.push(prUrl);

        return qodoRun({ stdout: JSON.stringify({ findings: [] }) });
      },
    });

    expect(await checkFindings(["--file=findings.json"], fromFile.io)).toBe(0);
    expect(await checkFindings(["--pr-url", "https://github.com/omerts/LamedDB/pull/40"], fromUrl.io)).toBe(0);
    expect(urls).toEqual(["https://github.com/omerts/LamedDB/pull/40"]);
    expect(qodoFindingsArgs("https://github.com/omerts/LamedDB/pull/42")).toEqual([
      "read",
      "pr-review-session",
      "findings",
      "--pr-url",
      "https://github.com/omerts/LamedDB/pull/42",
      "--extended",
      "--json",
    ]);
  });

  it("rejects a missing file, a credentialed URL, and conflicting flags", async () => {
    const missing = io();
    const credentialed = io({
      runQodo: async () => {
        throw new Error("qodo should not run");
      },
    });
    const both = io();

    expect(await checkFindings(["--file", "missing.json"], missing.io)).toBe(2);
    expect(missing.stderr()).toContain("ENOENT");
    expect(await checkFindings(["--pr-url", "https://user:secret@github.com/omerts/LamedDB/pull/42"], credentialed.io)).toBe(2);
    expect(credentialed.stderr()).toContain("without credentials");
    expect(credentialed.stderr()).not.toContain("secret");
    expect(await checkFindings(["--file", "a.json", "--pr-url", "https://github.com/omerts/LamedDB/pull/42"], both.io)).toBe(2);
  });

  it("reports a failed qodo command without printing a token", async () => {
    const previous = process.env.QODO_API_KEY;
    process.env.QODO_API_KEY = "unit-test-secret-value";

    try {
      const captured = io({
        runQodo: async () => qodoRun({
          status: 1,
          stderr: "auth failed for unit-test-secret-value and Bearer real-token",
        }),
      });
      const code = await checkFindings(["--pr-url", "https://github.com/omerts/LamedDB/pull/42"], captured.io);

      expect(code).toBe(2);
      expect(captured.stderr()).toContain("qodo exited 1");
      expect(captured.stderr()).toContain("[redacted]");
      expect(captured.stderr()).not.toContain("unit-test-secret-value");
      expect(captured.stderr()).not.toContain("real-token");
    } finally {
      if (previous === undefined) {
        delete process.env.QODO_API_KEY;
      } else {
        process.env.QODO_API_KEY = previous;
      }
    }
  });

  it("does not wait on a terminal when no input was given", async () => {
    let read = false;
    const captured = io({
      stdinIsTTY: true,
      readStdin: async () => {
        read = true;

        return "";
      },
    });

    expect(await checkFindings([], captured.io)).toBe(2);
    expect(read).toBe(false);
    expect(captured.stderr()).toContain("--file");
  });
});

describe("parseFindingsJson", () => {
  it("accepts a BOM and rejects empty or oversized JSON", () => {
    expect(parseFindingsJson("\uFEFF []")).toEqual({ ok: true, value: [] });
    expect(parseFindingsJson("   ")).toMatchObject({ ok: false, message: "Findings JSON is empty." });
    expect(parseFindingsJson("[]", 1)).toMatchObject({ ok: false, message: "Findings JSON exceeds the size limit." });
  });
});

describe("redactSecrets", () => {
  it("redacts bearer tokens and known token prefixes", () => {
    const text = redactSecrets("Bearer abc.def qodo_livekey ghp_abcdefghijklmnopqrstuvwxyz", ["unit-test-secret-value"]);

    expect(text).toContain("Bearer [redacted]");
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("qodo_livekey");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("qodo process", () => {
  it("builds only the read command and refuses an empty QODO_BIN", async () => {
    const previous = process.env.QODO_BIN;

    process.env.QODO_BIN = "";

    try {
      const result = await runQodoFindings("https://github.com/omerts/LamedDB/pull/42");

      expect(result.status).toBe(127);
      expect(result.stderr).toBe("QODO_BIN is invalid.");
    } finally {
      if (previous === undefined) {
        delete process.env.QODO_BIN;
      } else {
        process.env.QODO_BIN = previous;
      }
    }
  });

  it("kills a command that exceeds the output limit or the timeout", async () => {
    const overflow = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(100))"], {
      timeoutMs: 5_000,
      maxBytes: 16,
    });
    const timedOut = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      timeoutMs: 200,
      maxBytes: 1_000,
    });

    expect(overflow.overflow).toBe(true);
    expect(overflow.stdout).toBe("");
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.status).toBe(124);
  });

  it("reports a missing executable without running a shell", async () => {
    const missing = await runProcess("qodo-findings-check-missing", ["--pr-url", "https://example.test/pull/1;touch"], {
      timeoutMs: 2_000,
      maxBytes: 1_000,
    });

    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain("ENOENT");
  });
});

describe("bounded input", () => {
  it("stops reading a stream once the byte cap is exceeded", async () => {
    let produced = 0;
    const stream = Readable.from((async function* () {
      for (let index = 0; index < 20; index += 1) {
        produced += 1;
        yield Buffer.alloc(50, 97);
      }
    })());

    await expect(readStreamAtMost(stream, 120)).rejects.toBeInstanceOf(InputTooLargeError);
    expect(produced).toBeLessThan(20);
  });

  it("does not read the rest of an oversized findings file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qodo-findings-size-"));
    const file = join(dir, "findings.json");

    try {
      await writeFile(file, Buffer.alloc(2 * 1024 * 1024, 97));
      const stream = createReadStream(file, { highWaterMark: 16 * 1024 });

      await expect(readStreamAtMost(stream, 32 * 1024)).rejects.toBeInstanceOf(InputTooLargeError);
      expect(stream.bytesRead).toBeGreaterThan(0);
      expect(stream.bytesRead).toBeLessThan(512 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 when a reader stops at the size limit", async () => {
    const captured = io({
      readFile: async () => {
        throw new InputTooLargeError();
      },
    });

    expect(await checkFindings(["--file", "huge.json"], captured.io)).toBe(2);
    expect(captured.stderr()).toContain("Findings JSON exceeds the size limit.");
  });
});

describe("command entry", () => {
  it("runs the check script on a findings file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qodo-findings-"));
    const file = join(dir, "findings.json");

    try {
      await writeFile(file, JSON.stringify({ findings: [] }));
      const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-qodo-findings.ts", "--file", file], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });

      const [code] = (await once(child, "exit")) as [number | null];
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");

      expect(errors, output).toBe("");
      expect(output).toContain("No open High or Medium findings");
      expect(code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits every blocking finding when stderr is a pipe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qodo-findings-report-"));
    const file = join(dir, "findings.json");
    const findings = Array.from({ length: 800 }, (_, index) => ({
      id: `finding-${String(index).padStart(4, "0")}`,
      severity: "High",
      status: "pending",
      category: "Bug",
      title: "x".repeat(180),
      file: "scripts/check-qodo-findings.ts",
    }));

    try {
      await writeFile(file, JSON.stringify({ findings }));
      const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-qodo-findings.ts", "--file", file], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr: Buffer[] = [];

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });

      const [code] = (await once(child, "exit")) as [number | null];
      const errors = Buffer.concat(stderr).toString("utf8");

      expect(code).toBe(1);
      expect(errors).toContain("800 open High or Medium findings");
      expect(errors).toContain("finding-0000");
      expect(errors).toContain("finding-0799");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

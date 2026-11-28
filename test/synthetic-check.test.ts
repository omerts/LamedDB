import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { RunningServer } from "../src/index.js";
import { startTestServer, TEST_API_KEY } from "./helpers.js";

const execFileAsync = promisify(execFile);

interface CheckResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCheck(env: Record<string, string>): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/synthetic-check.mjs"], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
    });

    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };

    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe("scripts/synthetic-check.mjs", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function start(): Promise<string> {
    const test = await startTestServer();
    running = test.server;

    return test.server.url;
  }

  it("passes against a healthy server", async () => {
    const url = await start();
    const result = await runCheck({ LAMEDDB_URL: url, LAMEDDB_API_KEY: TEST_API_KEY });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("synthetic-check PASS");
  });

  it("fails when the expected value is not returned", async () => {
    const url = await start();
    const result = await runCheck({
      LAMEDDB_URL: url,
      LAMEDDB_API_KEY: TEST_API_KEY,
      LAMEDDB_CHECK_EXPECT_STATUS: "refunded",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("synthetic-check FAIL");
    expect(result.stderr).toContain('status "refunded"');
  });

  it("fails and does not print the key when the key is wrong", async () => {
    const url = await start();
    const result = await runCheck({ LAMEDDB_URL: url, LAMEDDB_API_KEY: "not-the-key" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("expected HTTP 201, got 401");
    expect(result.stderr).not.toContain("not-the-key");
  });

  it("exits 2 when the URL is missing", async () => {
    const result = await runCheck({ LAMEDDB_API_KEY: TEST_API_KEY });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("LAMEDDB_URL is required");
  });
});

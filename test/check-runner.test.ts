import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../.cursor/skills/api-behavior-check/scripts/check.self-test.mjs", import.meta.url));

describe("api behavior check runner", () => {
  it("skips 1xx, pins the server env, and checks error bodies", async () => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    if (child.stdout === null || child.stderr === null) {
      throw new Error("self-test stdout and stderr must be piped.");
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    const [code] = (await once(child, "exit")) as [number | null];
    const output = Buffer.concat([...stdout, ...stderr]).toString("utf8");

    expect(output).toContain("check self-test passed");
    expect(code, output).toBe(0);
  });
});

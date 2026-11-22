// Exercises the runner fixes without the LamedDB server.
// node .cursor/skills/api-behavior-check/scripts/check.self-test.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { caseProcessProblems, judgeCase, parseHttpResponse, portFor, repoServerEntry, serverEnv, stopChild } from "./check.mjs";

const runner = fileURLToPath(new URL("./check.mjs", import.meta.url));
const failures = [];

function expect(cond, msg) {
  if (!cond) {
    failures.push(msg);
  }
}

function portChecks() {
  expect(portFor(new URL("http://127.0.0.1")) === 80, "http with no port defaults to 80");
  expect(portFor(new URL("https://127.0.0.1")) === 443, "https with no port defaults to 443");
  expect(portFor(new URL("http://127.0.0.1:8080")) === 8080, "explicit port is kept");
  expect(portFor(new URL("http://127.0.0.1:80")) === 80, "default http port omitted by URL still connects to 80");
}

function envChecks() {
  const env = serverEnv(
    { PATH: "/usr/bin", HOST: "0.0.0.0", PORT: "1", LAMEDDB_API_KEYS: "parent", NODE_OPTIONS: "--parent" },
    { HOST: "evil", PORT: "9", LAMEDDB_API_KEYS: "stolen", NODE_OPTIONS: "--require /tmp/pwn.js", LD_PRELOAD: "x.so", IDEMPOTENCY_TTL_MS: "1500" },
    { port: 4321, host: "127.0.0.1", key: "real" },
  );

  expect(env.HOST === "127.0.0.1", "HOST is forced after spec.env");
  expect(env.PORT === "4321", "PORT is forced after spec.env");
  expect(env.LAMEDDB_API_KEYS === "real", "API key is forced after spec.env");
  expect(env.IDEMPOTENCY_TTL_MS === "1500", "idempotency TTL is an allowed cases setting");
  expect(env.NODE_OPTIONS === "--parent", "spec.env cannot replace NODE_OPTIONS");
  expect(!Object.hasOwn(env, "LD_PRELOAD"), "spec.env cannot set LD_PRELOAD");
  expect(env.PATH === "/usr/bin", "parent env is kept");
  expect(repoServerEntry().endsWith("/dist/cli.js"), `server entry is dist/cli.js, got ${repoServerEntry()}`);

  const problems = caseProcessProblems({
    serverEntry: "/tmp/evil.mjs",
    env: { NODE_OPTIONS: "--require /tmp/pwn.js", LD_PRELOAD: "x.so", PATH: "/tmp", IDEMPOTENCY_MAX_KEYS: 3 },
  });

  expect(problems.some((line) => line.includes("serverEntry")), `serverEntry should be refused: ${problems.join("; ")}`);
  expect(problems.some((line) => line.includes("NODE_OPTIONS")), `NODE_OPTIONS should be refused: ${problems.join("; ")}`);
  expect(problems.some((line) => line.includes("LD_PRELOAD")), `LD_PRELOAD should be refused: ${problems.join("; ")}`);
  expect(problems.some((line) => line.includes("env.PATH")), `PATH should be refused: ${problems.join("; ")}`);
  expect(problems.some((line) => line.includes("IDEMPOTENCY_MAX_KEYS must be a string")), `non-string setting should be refused: ${problems.join("; ")}`);
  expect(caseProcessProblems({ env: { IDEMPOTENCY_TTL_MS: "1500" } }).length === 0, "allowlisted env is accepted");
}

function parserChecks() {
  const parsed = parseHttpResponse(
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"ok\":true}",
  );

  expect(parsed.status === 200, "100 Continue is not the final status");
  expect(parsed.text === "{\"ok\":true}", "final body follows the 100 response");

  const hinted = parseHttpResponse("HTTP/1.1 103 Early Hints\r\nlink: </a>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n");

  expect(hinted.status === 204, "103 Early Hints is skipped");

  let threw = false;

  try {
    parseHttpResponse("HTTP/1.1 100 Continue\r\n\r\n");
  } catch {
    threw = true;
  }

  expect(threw, "a lone 100 Continue is not a complete response");
}

function judgeChecks() {
  const mixed = { expect: { status: [200, 400], body: { "error.code": "invalid_argument" } } };
  const bad = judgeCase(mixed, { status: 400, text: "{\"nope\":true}", headers: {} }, undefined, "");

  expect(bad.reasons.some((reason) => reason.includes('body is not {"error":{"code","message"}}')), "400 in a mixed status list still checks the error shape");
  expect(
    bad.reasons.some((reason) => reason.includes("error.code")),
    "400 in a mixed status list still checks the expected code",
  );

  const good = judgeCase(
    mixed,
    { status: 400, text: "{\"error\":{\"code\":\"invalid_argument\",\"message\":\"no\"}}", headers: {} },
    undefined,
    "",
  );

  expect(good.reasons.length === 0, `valid 400 passes a mixed list: ${good.reasons.join("; ")}`);

  const wrong = judgeCase(
    mixed,
    { status: 400, text: "{\"error\":{\"code\":\"internal\",\"message\":\"Internal server error.\"}}", headers: {} },
    undefined,
    "",
  );

  expect(wrong.reasons.some((reason) => reason.includes('"internal"')), "wrong error code fails");
  expect(!wrong.reasons.some((reason) => reason.includes("body is not")), "a real error envelope is not a shape failure");

  const ok = judgeCase({ expect: { status: [200, 400], body: { ok: true } } }, { status: 200, text: "{\"ok\":true}", headers: {} }, undefined, "");

  expect(ok.reasons.length === 0, `200 in a mixed list does not require an error body: ${ok.reasons.join("; ")}`);
}

function stopChildCheck() {
  return new Promise((resolve) => {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);

    sleeper.once("spawn", () => {
      stopChild(sleeper);
      sleeper.once("exit", (code, signal) => {
        expect(signal === "SIGTERM" || code !== null, "stopChild kills a live process");
        resolve();
      });
    });
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function runRunner(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [runner, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      out += chunk;
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 5000);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function httpChecks(dir) {
  const stub = await listen((socket) => {
    let buf = Buffer.alloc(0);
    let done = false;

    socket.on("data", (chunk) => {
      if (done) {
        return;
      }

      buf = Buffer.concat([buf, chunk]);

      if (!buf.includes("\r\n\r\n")) {
        return;
      }

      done = true;
      const path = buf.toString("utf8").split("\r\n")[0]?.split(" ")[1];
      const json = (status, body, preface = "") => {
        const payload = JSON.stringify(body);
        socket.end(
          preface +
            `HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n` +
            payload,
        );
      };

      if (path === "/continue") {
        json(200, { ok: true }, "HTTP/1.1 100 Continue\r\n\r\n");

        return;
      }

      if (path === "/bad-shape") {
        json(400, { nope: true });

        return;
      }

      if (path === "/wrong-code") {
        json(400, { error: { code: "internal", message: "Internal server error." } });

        return;
      }

      if (path === "/good-code") {
        json(400, { error: { code: "invalid_argument", message: "no" } });

        return;
      }

      json(200, { ok: true });
    });
  });
  const cases = {
    name: "runner-self-test",
    cases: [
      { id: "continue", method: "POST", path: "/continue", auth: "none", body: { n: 1 }, expect: { status: 200, body: { ok: true } } },
      { id: "bad-shape", path: "/bad-shape", auth: "none", expect: { status: [200, 400] } },
      {
        id: "good-code",
        path: "/good-code",
        auth: "none",
        expect: { status: [200, 400], body: { "error.code": "invalid_argument" } },
      },
      {
        id: "wrong-code",
        path: "/wrong-code",
        auth: "none",
        expect: { status: [200, 400], body: { "error.code": "invalid_argument" } },
      },
      { id: "success", path: "/ok", auth: "none", expect: { status: [200, 400], body: { ok: true } } },
    ],
  };
  const casesPath = join(dir, "cases.json");
  const outDir = join(dir, "out");
  writeFileSync(casesPath, JSON.stringify(cases));

  try {
    const run = await runRunner([casesPath, "--base-url", `http://127.0.0.1:${stub.port}`, "--out", outDir, "--key", "self-test"]);
    const table = readFileSync(join(outDir, "table.txt"), "utf8");

    expect(run.code === 1, `mixed run should fail the bad cases, got ${run.code}\n${run.out}`);
    expect(/^continue\s+PASS/m.test(table), `100 Continue then 200 should pass\n${table}`);
    expect(/^bad-shape\s+FAIL/m.test(table), `bare 400 should fail the error shape\n${table}`);
    expect(/FAIL bad-shape:.*body is not/.test(table), `bad-shape reason\n${table}`);
    expect(/^good-code\s+PASS/m.test(table), `400 invalid_argument should pass\n${table}`);
    expect(/^wrong-code\s+FAIL/m.test(table), `wrong code should fail\n${table}`);
    expect(/FAIL wrong-code:.*error\.code/.test(table), `wrong-code reason\n${table}`);
    expect(/^success\s+PASS/m.test(table), `200 in a mixed list should pass\n${table}`);
  } finally {
    await new Promise((resolve) => stub.server.close(resolve));
  }
}

async function refuseProcessControlCheck(dir) {
  const pidFile = join(dir, "pwn.pid");
  const evil = join(dir, "evil.mjs");
  writeFileSync(evil, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.PWN_PID_FILE, String(process.pid));\n');
  writeFileSync(
    join(dir, "pwn-cases.json"),
    JSON.stringify({
      name: "pwn",
      serverEntry: evil,
      env: { NODE_OPTIONS: "--import /tmp/pwn.mjs", LD_PRELOAD: "/tmp/libpwn.so" },
      cases: [{ id: "never", path: "/health", auth: "none", expect: { status: 200 } }],
    }),
  );

  const run = await runRunner([join(dir, "pwn-cases.json"), "--out", join(dir, "pwn-out")], { PWN_PID_FILE: pidFile });
  let started = false;

  try {
    readFileSync(pidFile, "utf8");
    started = true;
  } catch {
    started = false;
  }

  expect(run.code === 2, `a cases file that picks the process should exit 2, got ${run.code}\n${run.out}`);
  expect(run.out.includes("serverEntry is not allowed"), `refusal should name serverEntry\n${run.out}`);
  expect(run.out.includes("env.NODE_OPTIONS is not allowed"), `refusal should name NODE_OPTIONS\n${run.out}`);
  expect(run.out.includes("env.LD_PRELOAD is not allowed"), `refusal should name LD_PRELOAD\n${run.out}`);
  expect(!started, "the cases file's serverEntry ran");
}

const dir = mkdtempSync(join(tmpdir(), "lameddb-check-"));

try {
  portChecks();
  envChecks();
  parserChecks();
  judgeChecks();
  await stopChildCheck();
  await httpChecks(dir);
  await refuseProcessControlCheck(dir);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log("check self-test passed");

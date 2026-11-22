#!/usr/bin/env node
// api-behavior-check runner. Node >= 20, no dependencies.
// Usage: node .cursor/skills/api-behavior-check/scripts/check.mjs <cases.json> [--out DIR] [--base-url URL] [--key KEY]
// Exit codes: 0 all PASS | 1 at least one FAIL | 2 NEEDS INPUT (stop and ask) | 3 setup error
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const casesFile = args[0];
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
if (!casesFile) die(3, "usage: check.mjs <cases.json> [--out DIR] [--base-url URL] [--key KEY]");
const spec = JSON.parse(readFileSync(casesFile, "utf8"));
const outDir = resolve(opt("--out") ?? join("evidence", `${spec.name ?? "check"}-${Date.now()}`));
mkdirSync(outDir, { recursive: true });

// ---- 1. Refuse to run when the ticket left something unspecified
const missing = [];
for (const c of spec.cases ?? []) {
  const e = c.expect ?? {};
  if (!c.id || (!c.path && !c.rawTarget)) missing.push(`${c.id ?? "?"}: needs id and path or rawTarget`);
  if (e.status === undefined || e.status === null || (Array.isArray(e.status) && e.status.length === 0)) missing.push(`${c.id}: ticket gives no expected status`);
  if (Number(e.status) >= 400 || (Array.isArray(e.status) && e.status.every((s) => s >= 400))) {
    if (!e.body || Object.keys(e.body).length === 0) missing.push(`${c.id}: error case has no expected body fields (e.g. {"error.code":"..."})`);
  }
}
if (!spec.cases?.length) missing.push("no cases");
if (missing.length) {
  console.log("NEEDS INPUT - stop and ask the user before running:\n" + missing.map((m) => " - " + m).join("\n"));
  writeFileSync(join(outDir, "needs-input.txt"), missing.join("\n") + "\n");
  process.exit(2);
}

// ---- 2. Server: fresh process, fresh in-memory store (LamedDB has no data dir yet)
const key = opt("--key") ?? `chk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
let base = opt("--base-url");
let child; let logs = "";
if (!base) {
  const entry = resolve(spec.serverEntry ?? "dist/cli.js");
  if (!existsSync(entry)) die(3, `${entry} not found. Run: npm ci && npm run build`);
  const port = await freePort();
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LAMEDDB_API_KEYS: key, ...(spec.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) die(3, "server exited early:\n" + logs);
    if (i > 100) die(3, "server did not start in 10s:\n" + logs);
    try { await fetch(base + "/health"); break; } catch { await sleep(100); }
  }
}
const u = new URL(base);
const sub = (v) => (typeof v === "string" ? v.replaceAll("${KEY}", key) : v);

// ---- 3. HTTP helpers
async function send(c) {
  const headers = { ...(c.headers ?? {}) };
  const auth = c.auth ?? "valid"; // valid | none | any literal header value
  if (auth === "valid") headers.authorization = `Bearer ${key}`;
  else if (auth !== "none") headers.authorization = sub(auth);
  for (const k of Object.keys(headers)) headers[k] = sub(headers[k]);
  let body = c.body === undefined ? undefined : typeof c.body === "string" ? c.body : JSON.stringify(c.body);
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const method = c.method ?? "GET";
  const target = c.rawTarget ?? c.path;
  // Raw socket so malformed request targets reach the server unchanged.
  return await new Promise((res, rej) => {
    const sock = connect(Number(u.port), u.hostname);
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { sock.destroy(); rej(new Error("timeout")); }, 8000);
    sock.on("connect", () => {
      let head = `${method} ${target} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n`;
      for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
      if (body !== undefined) head += `content-length: ${Buffer.byteLength(body)}\r\n`;
      sock.write(head + "\r\n" + (body ?? ""));
    });
    sock.on("data", (d) => (buf = Buffer.concat([buf, d])));
    sock.on("error", rej);
    sock.on("close", () => {
      clearTimeout(t);
      const raw = buf.toString("utf8");
      const i = raw.indexOf("\r\n\r\n");
      if (i < 0) return rej(new Error("no HTTP response (connection closed). raw=" + JSON.stringify(raw.slice(0, 200))));
      const [statusLine, ...hl] = raw.slice(0, i).split("\r\n");
      const h = Object.fromEntries(hl.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      let text = raw.slice(i + 4);
      if (h["transfer-encoding"] === "chunked") {
        let out = ""; let rest = text;
        while (rest) { const n = rest.indexOf("\r\n"); const len = parseInt(rest.slice(0, n), 16); if (!len) break; out += rest.slice(n + 2, n + 2 + len); rest = rest.slice(n + 2 + len + 2); }
        text = out;
      }
      res({ status: Number(statusLine.split(" ")[1]), headers: h, text });
    });
  });
}
const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);

// ---- 4. Fixture (must succeed or we stop: a wrong fixture makes every result meaningless)
const transcript = [];
for (const f of spec.fixture ?? []) {
  const r = await send({ ...f, auth: f.auth ?? "valid" });
  transcript.push({ phase: "fixture", request: show(f), status: r.status, body: r.text });
  const want = f.expectStatus ?? [200, 201, 204];
  if (!want.includes(r.status)) { child?.kill(); die(3, `fixture step failed: ${f.method} ${f.path} -> ${r.status} ${r.text}`); }
}

// ---- 5. Cases
const rows = []; let needsInput = false;
for (const c of spec.cases) {
  const logStart = logs.length;
  let r, err;
  try { r = await send(c); } catch (e) { err = String(e.message ?? e); }
  await sleep(50);
  const newLogs = logs.slice(logStart);
  const reasons = [];
  let json; if (r) { try { json = JSON.parse(r.text); } catch { json = undefined; } }
  const want = [].concat(c.expect.status);
  if (err) reasons.push(`no response: ${err}`);
  else {
    if (!want.includes(r.status)) reasons.push(`status ${r.status}, want ${want.join(" or ")}`);
    for (const [p, v] of Object.entries(c.expect.body ?? {})) {
      const got = getPath(json, p);
      const ok = v === "*" ? got !== undefined : v === null ? got === undefined : Array.isArray(v) ? v.includes(got) : got === v;
      if (!ok) reasons.push(`body.${p} = ${JSON.stringify(got)}, want ${JSON.stringify(v)}`);
    }
    if (c.expect.errorShape && (!json || typeof json.error?.code !== "string" || typeof json.error?.message !== "string")) reasons.push('body is not {"error":{"code","message"}}');
    for (const p of c.expect.serverLogMustNotMatch ?? []) if (new RegExp(p, "i").test(newLogs)) reasons.push(`server log matched /${p}/: ${newLogs.trim().split("\n")[0]}`);
    // Endpoint not found: 404/405 where the ticket did not expect it means the cases file or the endpoint is wrong. Ask.
    if ((r.status === 404 || r.status === 405) && !want.includes(r.status) && json?.error?.code !== "internal" && !c.expect.allowNotFound) { needsInput = true; reasons.push(`ENDPOINT NOT FOUND/ALLOWED (${r.status}); confirm path/method with the user`); }
  }
  rows.push({ id: c.id, criterion: c.criterion ?? "", desc: c.desc ?? "", request: show(c), want: want.join("|") + (c.expect.body ? " " + JSON.stringify(c.expect.body) : ""), got: r ? `${r.status} ${r.text.slice(0, 160)}` : "-", result: reasons.length ? "FAIL" : "PASS", reasons });
  transcript.push({ phase: "case", id: c.id, request: show(c), status: r?.status, headers: r?.headers, body: r?.text, serverLog: newLogs.trim() || undefined, result: reasons.length ? "FAIL" : "PASS", reasons });
}
child?.kill();

// ---- 6. Report + evidence
const pad = (s, n) => String(s).slice(0, n).padEnd(n);
let table = `${pad("ID", 12)} ${pad("RESULT", 6)} ${pad("REQUEST", 44)} ${pad("EXPECTED", 38)} GOT\n`;
for (const x of rows) table += `${pad(x.id, 12)} ${pad(x.result, 6)} ${pad(x.request, 44)} ${pad(x.want, 38)} ${x.got.replace(/\s+/g, " ").slice(0, 70)}\n`;
const fails = rows.filter((x) => x.result === "FAIL");
table += `\n${rows.length - fails.length}/${rows.length} PASS\n` + fails.map((x) => `FAIL ${x.id}: ${x.reasons.join("; ")}`).join("\n") + (fails.length ? "\n" : "");
console.log(table);
const md = `# ${spec.name ?? "API behavior check"}\n\nTicket: ${spec.ticket ?? "n/a"}\nCommit: ${process.env.CHECK_COMMIT ?? "(set CHECK_COMMIT)"}\nRun: ${new Date().toISOString()}\n\n| ID | Criterion | Request | Expected | Got | Result |\n|---|---|---|---|---|---|\n` +
  rows.map((x) => `| ${x.id} | ${x.criterion} | \`${x.request}\` | ${esc(x.want)} | ${esc(x.got.replace(/\s+/g, " "))} | **${x.result}** |`).join("\n") + "\n" +
  fails.map((x) => `\n- FAIL ${x.id}: ${x.reasons.join("; ")}`).join("") + "\n";
writeFileSync(join(outDir, "results.md"), md);
writeFileSync(join(outDir, "transcript.json"), JSON.stringify(transcript, null, 2).replaceAll(key, "<KEY>"));
writeFileSync(join(outDir, "table.txt"), table);
console.log(`evidence: ${outDir}/{table.txt,results.md,transcript.json}`);
process.exit(needsInput ? 2 : fails.length ? 1 : 0);

function show(c) { return `${c.method ?? "GET"} ${c.rawTarget ?? c.path}${c.auth === "none" ? " (no key)" : ""}`; }
function esc(s) { return String(s).replaceAll("|", "\\|"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function die(code, msg) { console.error(msg); process.exit(code); }
function freePort() { return new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); }); }

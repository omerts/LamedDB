---
name: api-behavior-check
description: Runs a live HTTP behavior check of LamedDB endpoints against a real server process. Sends the exact requests from a ticket's acceptance criteria (including malformed or unauthenticated ones), compares status codes and error body shape to the ticket, and saves a request/response transcript plus a PASS/FAIL table. Use when a ticket or PR changes HTTP status codes, error bodies, auth, routing or request parsing in src/http/, or when asked to "verify against the ticket", "check the API behavior" or reproduce a bug over HTTP. Not for SDK-only or unit-level changes.
compatibility: Needs Node 20+, npm, and loopback networking. Run from the repo root. No other services.
metadata:
  project: LamedDB
  version: "1.0"
---

# API behavior check (LamedDB)

Proves behavior over real HTTP, not just unit tests. Passing tests or a clean review is not evidence that this check ran. The evidence is the saved table and transcript.

## Project context
- Server: `dist/cli.js`, built by `npm run build`. Env: `PORT`, `HOST` (default 127.0.0.1), `LAMEDDB_API_KEYS` (comma list, required).
- Storage is in-memory only (no data dir). A fresh server process is the fresh state. The runner starts one on a free port with a random key.
- Auth: header `Authorization: Bearer <key>`. Only `GET /health` skips it.
- Error body shape: `{"error":{"code","message","details?"}}`. Codes and statuses are in `src/errors.ts`: invalid_argument 400, unauthenticated 401, not_found 404, method_not_allowed 405, already_exists 409, idempotency_conflict 409, precondition_failed 412, internal 500. There is no `bad_request` code. A ticket that names one still has to be confirmed; do not rename it on your own.
- Repo rules: read `AGENTS.md` before changing code.

## Required inputs
1. A ticket (issue URL or text) with acceptance criteria that name requests and expected outcomes.
2. The commit under test (`git rev-parse --short HEAD`).

## Steps
1. Read the ticket. For each criterion that is about HTTP behavior, write one case. Include the bad and malformed requests the ticket names. Do not invent cases the ticket does not imply, except 1-2 normal-path regression cases.
2. **Stop and ask the user (do not guess)** if any of these is true:
   - a case has no expected status in the ticket,
   - the ticket names an error code that is not in `src/errors.ts` (name the mismatch and ask which is right),
   - the ticket gives a status but no code, and that status maps to more than one code in `src/errors.ts` (409 is both `already_exists` and `idempotency_conflict`),
   - the endpoint does not exist in `src/http/server.ts`,
   - the ticket is ambiguous (e.g. "401 or 400"): you may encode both as allowed statuses, but say so in your report.
   When a ticket gives a status and no error code, and `src/errors.ts` maps that status to exactly one code, use that code and the standard body `{"error":{"code","message"}}`. Note the mapping in the report. Do not ask. A code the ticket names that `src/errors.ts` does not have is still a stop, even when that status has a single mapped code.
3. Write the cases file to `evidence/<ticket>/cases.json` using the format in `references/cases-format.md`. A worked example is `references/example-cases-18.json`.
4. Build and run:
   ```bash
   npm ci && npm run build
   CHECK_COMMIT=$(git rev-parse --short HEAD) node .cursor/skills/api-behavior-check/scripts/check.mjs evidence/<ticket>/cases.json --out evidence/<ticket>/run-1
   ```
   Exit code: `0` all pass, `1` a case failed, `2` NEEDS INPUT (script refused or hit an unknown endpoint; stop and ask), `3` setup error.
5. Read the printed table. For every FAIL, look at the reason column and `transcript.json` (it also holds the server log lines for that request) and decide: real bug in the code, or wrong case. Do not edit expectations just to turn a FAIL green; the ticket is the source of truth.
6. If the task is to fix code: first run the check on the unfixed code and keep that run as `run-before`. Fix, rebuild (`npm run build`), re-run into `run-after`. Add repo tests as the ticket asks. Then `npm run typecheck && npm test`.
7. Evidence to keep: `evidence/<ticket>/{cases.json,run-*/table.txt,run-*/results.md,run-*/transcript.json}`. Paste the final table and the exact command into the PR description, with the commit hash. Do not commit `evidence/` unless asked.

## Expected result
Every case PASS on the final commit, and the before-run FAIL on exactly the cases the bug affects. A run where only a subset of the ticket's cases ran is incomplete: say so.

## Report format
Commit, command, the table, which criteria map to which case ids, anything you had to ask or assumed, and the evidence directory.

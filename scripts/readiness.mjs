// Readiness assessment for a pull request. Plain Node 20+, no dependencies.
// Inputs (env): GITHUB_TOKEN, REPO (owner/name), PR_NUMBER (optional), CHECKS (JSON {name: outcome}).
// Writes readiness.json and the job summary. Exits 0 even when NOT READY (the verdict is the output).
import { appendFileSync, writeFileSync } from "node:fs";

const API = process.env.GITHUB_API_URL || "https://api.github.com";
const GQL = process.env.GITHUB_GRAPHQL_URL || `${API}/graphql`;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.REPO;
const prNumber = Number(process.env.PR_NUMBER) || null;
const checks = JSON.parse(process.env.CHECKS || "{}");

const QODO_BOT = "qodo-code-review[bot]";
const APPROVED_LABEL = "Qodo approved";
const GUARDED = /^src\/http\//; // human review required here (matches the gate's guard)

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function rest(path) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${API}${path}${sep}per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) return body;
    out.push(...body);
    if (body.length < 100) break;
  }
  return out;
}

async function threads(number) {
  const [owner, name] = repo.split("/");
  const all = [];
  let after = null;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(GQL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `query($owner:String!,$name:String!,$n:Int!,$after:String){
          repository(owner:$owner,name:$name){pullRequest(number:$n){
            reviewThreads(first:100,after:$after){
              pageInfo{hasNextPage endCursor}
              nodes{isResolved isOutdated path comments(first:1){nodes{author{login} body url}}}}}}}`,
        variables: { owner, name, n: number, after },
      }),
    });
    const json = await res.json();
    if (!res.ok || json.errors) throw new Error(`GraphQL failed: ${JSON.stringify(json.errors || res.status)}`);
    const t = json.data.repository.pullRequest.reviewThreads;
    all.push(...t.nodes);
    if (!t.pageInfo.hasNextPage) break;
    after = t.pageInfo.endCursor;
  }
  return all;
}

const reasons = [];
const notes = [];
const result = { checks, pr: prNumber, verdict: null, reasons, notes };

// 1. Tests and other checks
const failedChecks = Object.entries(checks).filter(([, v]) => v !== "success");
for (const [k, v] of failedChecks) reasons.push(`Check "${k}" ${v}`);

// 2. Review status
if (!prNumber) {
  notes.push("No PR number given: only the checks were assessed.");
  result.review = null;
} else {
  const pr = await rest(`/repos/${repo}/pulls/${prNumber}`);
  const files = await rest(`/repos/${repo}/pulls/${prNumber}/files`);
  const reviews = await rest(`/repos/${repo}/pulls/${prNumber}/reviews`);
  const issueComments = await rest(`/repos/${repo}/issues/${prNumber}/comments`);
  const ths = await threads(prNumber);

  const headSha = pr.head.sha;
  const labels = pr.labels.map((l) => l.name);
  const guardedFiles = files.map((f) => f.filename).filter((f) => GUARDED.test(f));

  // Qodo: has it reviewed the latest commit?
  const commit = await rest(`/repos/${repo}/commits/${headSha}`);
  const headTime = new Date(commit.commit.committer.date).getTime();
  const qodoTimes = [
    ...issueComments.filter((c) => c.user?.login === QODO_BOT).map((c) => c.updated_at || c.created_at),
    ...reviews.filter((r) => r.user?.login === QODO_BOT).map((r) => r.submitted_at),
  ].map((t) => new Date(t).getTime());
  const qodoReviewed = qodoTimes.length > 0;
  const qodoCoversHead = qodoTimes.some((t) => t >= headTime);

  // Unresolved threads (outdated ones are listed but do not count as open)
  const open = ths.filter((t) => !t.isResolved && !t.isOutdated);
  const unresolved = open.map((t) => {
    const c = t.comments.nodes[0];
    return { path: t.path, author: c?.author?.login ?? null, url: c?.url ?? null, excerpt: (c?.body ?? "").replace(/\s+/g, " ").slice(0, 140) };
  });

  // Human approval on the current head commit (latest decisive review per person)
  const latest = new Map();
  for (const r of reviews) {
    if (r.user?.type === "Bot" || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
    latest.set(r.user.login, r);
  }
  const humanApprovals = [...latest.values()].filter((r) => r.state === "APPROVED" && r.commit_id === headSha).map((r) => r.user.login);
  const changesRequested = [...latest.values()].filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.user.login);

  result.review = {
    headSha,
    draft: pr.draft,
    labels,
    qodoReviewed,
    qodoCoversHead,
    qodoApprovedLabel: labels.includes(APPROVED_LABEL),
    guardedFiles,
    humanApprovals,
    changesRequested,
    unresolvedThreads: unresolved,
    totalThreads: ths.length,
  };

  if (pr.draft) reasons.push("PR is a draft");
  if (!qodoReviewed) reasons.push("No Qodo review found on this PR");
  else if (!qodoCoversHead) reasons.push("Qodo's latest review is older than the latest commit (ask for /agentic_review)");
  if (!labels.includes(APPROVED_LABEL)) reasons.push(`Missing "${APPROVED_LABEL}" label (Qodo found Medium+ issues or hasn't finished)`);
  if (unresolved.length) reasons.push(`${unresolved.length} unresolved review thread(s)`);
  if (changesRequested.length) reasons.push(`Changes requested by ${changesRequested.join(", ")}`);
  if (guardedFiles.length && !humanApprovals.length) reasons.push(`Touches guarded path (${guardedFiles.length} file(s) under src/http/): needs a human approval on the latest commit`);
  if (guardedFiles.length && humanApprovals.length) notes.push(`Guarded path approved by ${humanApprovals.join(", ")}`);
}

result.verdict = reasons.length ? "NOT READY" : "READY";
writeFileSync("readiness.json", JSON.stringify(result, null, 2));

const icon = (v) => (v === "success" ? "✅" : "❌");
let md = `## Readiness: ${result.verdict === "READY" ? "✅ READY" : "⛔ NOT READY"}\n\n`;
if (reasons.length) md += reasons.map((r) => `- ${r}`).join("\n") + "\n\n";
md += `### Checks\n| Check | Result |\n|---|---|\n` + Object.entries(checks).map(([k, v]) => `| ${k} | ${icon(v)} ${v} |`).join("\n") + "\n\n";
if (result.review) {
  const r = result.review;
  md += `### Review (PR #${prNumber}, \`${r.headSha.slice(0, 7)}\`)\n`;
  md += `- Qodo reviewed: ${r.qodoReviewed ? "yes" : "no"}; covers latest commit: ${r.qodoCoversHead ? "yes" : "no"}\n`;
  md += `- "${APPROVED_LABEL}" label: ${r.qodoApprovedLabel ? "yes" : "no"}\n`;
  md += `- Guarded files (src/http/**): ${r.guardedFiles.length}; human approvals: ${r.humanApprovals.join(", ") || "none"}\n`;
  md += `- Unresolved threads: ${r.unresolvedThreads.length} of ${r.totalThreads}\n`;
  for (const t of r.unresolvedThreads) md += `  - \`${t.path}\` (${t.author}): ${t.excerpt} ${t.url ?? ""}\n`;
}
for (const n of notes) md += `\n> ${n}\n`;
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

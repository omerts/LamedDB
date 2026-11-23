// Readiness assessment for a pull request. Plain Node 20+, no dependencies.
// The workflow checks out this file from the default branch and passes:
// GITHUB_TOKEN, REPO (owner/name), PR_NUMBER (optional), WORKFLOW_RUN_ID (optional).
// Check results are read from the Readiness checks workflow for the pull request head.
// Writes readiness.json and the job summary. Exits 0 even when NOT READY.
import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const QODO_BOT = "qodo-code-review[bot]";
const APPROVED_LABEL = "Qodo approved";
const GUARDED = /^src\/http\//;
const REQUIRED_CHECKS = ["install", "typecheck", "build", "tests"];
const STEP_NAMES = {
  Install: "install",
  Typecheck: "typecheck",
  Build: "build",
  Tests: "tests",
};

export function emptyChecks() {
  return {
    install: "missing",
    typecheck: "missing",
    build: "missing",
    tests: "missing",
  };
}

export function checksFromJobs(jobs) {
  const checks = emptyChecks();
  const job = (jobs || []).find((item) => item.name === "checks");

  if (!job) {
    return checks;
  }

  for (const step of job.steps || []) {
    const key = STEP_NAMES[step.name];

    if (!key) {
      continue;
    }

    checks[key] = stepOutcome(step);
  }

  return checks;
}

function stepOutcome(step) {
  if (typeof step.conclusion === "string" && step.conclusion) {
    return step.conclusion;
  }

  if (typeof step.status === "string" && step.status && step.status !== "completed") {
    return step.status;
  }

  return "missing";
}

export async function fetchPagedList(fetchPage, { maxPages, pageSize }) {
  const items = [];

  for (let page = 1; page <= maxPages; page++) {
    const body = await fetchPage(page);

    if (!Array.isArray(body)) {
      throw new Error("Expected a list from the GitHub API");
    }

    items.push(...body);

    if (body.length < pageSize) {
      return { items, truncated: false };
    }
  }

  return { items, truncated: true };
}

export function atOrAfter(iso, headTime) {
  const value = Date.parse(iso ?? "");

  return Number.isFinite(value) && Number.isFinite(headTime) && value >= headTime;
}

function checkReasons(checks) {
  const reasons = [];

  for (const name of REQUIRED_CHECKS) {
    const outcome = checks?.[name];

    if (outcome !== "success") {
      reasons.push(`Check "${name}" ${outcome || "missing"}`);
    }
  }

  return reasons;
}

function approvalLabel(labels, events, truncated, headTime) {
  const present = labels.includes(APPROVED_LABEL);

  if (!present) {
    return {
      ok: false,
      reason: `Missing "${APPROVED_LABEL}" label (Qodo found Medium+ issues or hasn't finished)`,
    };
  }

  if (truncated) {
    return { ok: false, reason: null };
  }

  let latest = null;

  for (const event of events) {
    if (event.event !== "labeled" || event.label?.name !== APPROVED_LABEL) {
      continue;
    }

    if (!latest || Date.parse(event.created_at) > Date.parse(latest.created_at)) {
      latest = event;
    }
  }

  if (!latest || latest.actor?.login !== QODO_BOT) {
    return {
      ok: false,
      reason: `The "${APPROVED_LABEL}" label was not applied by Qodo for the latest commit`,
    };
  }

  if (!atOrAfter(latest.created_at, headTime)) {
    return {
      ok: false,
      reason: `The "${APPROVED_LABEL}" label is older than the latest commit`,
    };
  }

  return { ok: true, reason: null };
}

function issueCommentCoversHead(comment, headSha, headTime) {
  const body = comment.body || "";

  if (comment.user?.login !== QODO_BOT || !body.includes(headSha)) {
    return false;
  }

  return atOrAfter(comment.created_at, headTime) || atOrAfter(comment.updated_at, headTime);
}

export function assess(input) {
  const reasons = [];
  const notes = [];
  const checks = { ...emptyChecks(), ...input.checks };

  if (input.checksMismatch) {
    reasons.push(
      `Readiness checks ran for ${input.checksMismatch.runSha}, not the pull request head ${input.checksMismatch.headSha}`,
    );
  } else {
    reasons.push(...checkReasons(checks));

    if (input.checksMissing) {
      reasons.push("No readiness checks run found for the latest commit");
    }
  }

  if (input.checksTruncated) {
    reasons.push("Check job list is incomplete; cannot confirm every check");
  }

  const result = {
    checks,
    pr: input.prNumber ?? null,
    verdict: null,
    reasons,
    notes,
    review: null,
  };

  if (!input.pr) {
    if (input.prNumber) {
      reasons.push("Pull request could not be loaded");
    } else {
      notes.push("No PR number given: only the checks were assessed.");
    }

    result.verdict = reasons.length ? "NOT READY" : "READY";

    return result;
  }

  const headSha = input.pr.head.sha;
  const headTime = Date.parse(input.headCommittedAt);
  const labels = (input.pr.labels || []).map((label) => (typeof label === "string" ? label : label.name));

  if (!Number.isFinite(headTime)) {
    reasons.push("Head commit timestamp is missing");
  }

  if (input.filesTruncated) {
    reasons.push("PR file list is incomplete; cannot confirm whether src/http/ is touched");
  }

  if (input.reviewsTruncated) {
    reasons.push("Review list is incomplete; cannot confirm Qodo or human approval");
  }

  if (input.reviewCommentsTruncated) {
    reasons.push("Review comment list is incomplete; cannot confirm Qodo reviewed the latest commit");
  }

  if (input.issueCommentsTruncated) {
    reasons.push("Comment list is incomplete; cannot confirm Qodo reviewed the latest commit");
  }

  if (input.eventsTruncated) {
    reasons.push('Label history is incomplete; cannot confirm the "Qodo approved" label applies to the latest commit');
  }

  if (input.threadsTruncated) {
    reasons.push("Review thread list is incomplete; cannot confirm every thread is resolved");
  }

  const guardedFiles = (input.files || [])
    .filter((file) => GUARDED.test(file.filename || "") || GUARDED.test(file.previous_filename || ""))
    .map((file) => (GUARDED.test(file.filename || "") ? file.filename : file.previous_filename));

  const reviews = input.reviews || [];
  const reviewComments = input.reviewComments || [];
  const issueComments = input.issueComments || [];
  const qodoReviews = reviews.filter((review) => review.user?.login === QODO_BOT);
  const qodoReviewComments = reviewComments.filter((comment) => comment.user?.login === QODO_BOT);
  const qodoIssueComments = issueComments.filter((comment) => comment.user?.login === QODO_BOT);
  const qodoReviewed = qodoReviews.length > 0 || qodoReviewComments.length > 0 || qodoIssueComments.length > 0;
  const qodoCoversHead =
    qodoReviews.some(
      (review) =>
        review.commit_id === headSha &&
        review.state !== "DISMISSED" &&
        review.state !== "PENDING" &&
        atOrAfter(review.submitted_at, headTime),
    ) ||
    qodoReviewComments.some(
      (comment) => comment.original_commit_id === headSha && atOrAfter(comment.created_at, headTime),
    ) ||
    qodoIssueComments.some((comment) => issueCommentCoversHead(comment, headSha, headTime));
  const labelState = approvalLabel(labels, input.events || [], input.eventsTruncated, headTime);
  const unresolved = (input.threads || [])
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const comment = thread.comments?.nodes?.[0];

      return {
        path: thread.path,
        outdated: Boolean(thread.isOutdated),
        author: comment?.author?.login ?? null,
        url: comment?.url ?? null,
        excerpt: (comment?.body ?? "").replace(/\s+/g, " ").slice(0, 140),
      };
    });
  const latest = new Map();

  for (const review of reviews) {
    if (review.user?.type === "Bot" || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      continue;
    }

    latest.set(review.user.login, review);
  }

  const humanApprovals = [...latest.values()]
    .filter((review) => review.state === "APPROVED" && review.commit_id === headSha)
    .map((review) => review.user.login);
  const changesRequested = [...latest.values()]
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .map((review) => review.user.login);

  result.review = {
    headSha,
    draft: Boolean(input.pr.draft),
    labels,
    qodoReviewed,
    qodoCoversHead,
    qodoApprovedLabel: labelState.ok,
    guardedFiles,
    humanApprovals,
    changesRequested,
    unresolvedThreads: unresolved,
    totalThreads: (input.threads || []).length,
  };

  if (input.pr.draft) {
    reasons.push("PR is a draft");
  }

  if (!qodoReviewed) {
    reasons.push("No Qodo review found on this PR");
  } else if (!qodoCoversHead) {
    reasons.push("Qodo has not reviewed the latest commit (ask for /agentic_review)");
  }

  if (labelState.reason) {
    reasons.push(labelState.reason);
  }

  if (unresolved.length) {
    reasons.push(`${unresolved.length} unresolved review thread(s)`);
  }

  if (changesRequested.length) {
    reasons.push(`Changes requested by ${changesRequested.join(", ")}`);
  }

  if (guardedFiles.length && !humanApprovals.length) {
    reasons.push(
      `Touches guarded path (${guardedFiles.length} file(s) under src/http/): needs a human approval on the latest commit`,
    );
  }

  if (guardedFiles.length && humanApprovals.length) {
    notes.push(`Guarded path approved by ${humanApprovals.join(", ")}`);
  }

  result.verdict = reasons.length ? "NOT READY" : "READY";

  return result;
}

function render(result) {
  const icon = (value) => (value === "success" ? "✅" : "❌");
  let markdown = `## Readiness: ${result.verdict === "READY" ? "✅ READY" : "⛔ NOT READY"}\n\n`;

  if (result.reasons.length) {
    markdown += result.reasons.map((reason) => `- ${reason}`).join("\n") + "\n\n";
  }

  const rows = Object.entries(result.checks)
    .map(([name, value]) => `| ${name} | ${icon(value)} ${value} |`)
    .join("\n");

  markdown += `### Checks\n| Check | Result |\n|---|---|\n${rows}\n\n`;

  if (result.review) {
    const review = result.review;

    markdown += `### Review (PR #${result.pr}, \`${review.headSha.slice(0, 7)}\`)\n`;
    markdown += `- Qodo reviewed: ${review.qodoReviewed ? "yes" : "no"}; covers latest commit: ${review.qodoCoversHead ? "yes" : "no"}\n`;
    markdown += `- "${APPROVED_LABEL}" label applies to latest commit: ${review.qodoApprovedLabel ? "yes" : "no"}\n`;
    markdown += `- Guarded files (src/http/**): ${review.guardedFiles.length}; human approvals: ${review.humanApprovals.join(", ") || "none"}\n`;
    markdown += `- Unresolved threads: ${review.unresolvedThreads.length} of ${review.totalThreads}\n`;

    for (const thread of review.unresolvedThreads) {
      const outdated = thread.outdated ? ", outdated" : "";

      markdown += `  - \`${thread.path}\` (${thread.author}${outdated}): ${thread.excerpt} ${thread.url ?? ""}\n`;
    }
  }

  for (const note of result.notes) {
    markdown += `\n> ${note}\n`;
  }

  return markdown;
}

function publish(result) {
  const markdown = render(result);

  writeFileSync("readiness.json", JSON.stringify(result, null, 2));
  console.log(markdown);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

function failure(checks, pr, reasons, notes = []) {
  return {
    checks,
    pr,
    verdict: "NOT READY",
    reasons,
    notes,
    review: null,
  };
}

function parsePrNumber(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { value: null, error: null };
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    return { value: null, error: "PR number is invalid" };
  }

  return { value, error: null };
}

async function getJson(url, fetchImpl, headers) {
  const response = await fetchImpl(url, { headers });
  let body = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const path = new URL(url).pathname;

    throw new Error(`GET ${path} -> ${response.status}`);
  }

  return body;
}

async function fetchThreads(gql, headers, fetchImpl, repo, number, maxPages) {
  const [owner, name] = repo.split("/");
  const threads = [];
  let after = null;

  for (let page = 1; page <= maxPages; page++) {
    const response = await fetchImpl(gql, {
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
    let json = null;

    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok || json?.errors) {
      const detail = json?.errors ? JSON.stringify(json.errors).slice(0, 300) : String(response.status);

      throw new Error(`GraphQL failed: ${detail}`);
    }

    const connection = json?.data?.repository?.pullRequest?.reviewThreads;

    if (!connection) {
      throw new Error("GraphQL failed: pull request threads were missing");
    }

    threads.push(...(connection.nodes || []));

    if (!connection.pageInfo?.hasNextPage) {
      return { threads, truncated: false };
    }

    after = connection.pageInfo.endCursor;
  }

  return { threads, truncated: true };
}

async function loadChecks(get, env, repo, headSha, limits) {
  const workflow = env.CHECKS_WORKFLOW || "readiness-checks.yml";
  const listed = await get(
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${encodeURIComponent(headSha)}&per_page=5`,
  );
  let run = (listed.workflow_runs || []).find((item) => item.head_sha === headSha) || null;
  let mismatch = null;

  if (!run && env.WORKFLOW_RUN_ID) {
    const candidate = await get(`/repos/${repo}/actions/runs/${encodeURIComponent(env.WORKFLOW_RUN_ID)}`);
    const sameWorkflow = String(candidate.path || "").endsWith(workflow);

    if (candidate.head_sha === headSha && sameWorkflow) {
      run = candidate;
    } else if (candidate.head_sha && candidate.head_sha !== headSha) {
      mismatch = { runSha: candidate.head_sha, headSha };
    }
  }

  if (!run) {
    return { checks: emptyChecks(), found: false, truncated: false, mismatch };
  }

  const jobs = await fetchPagedList(
    async (page) => {
      const body = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=${limits.pageSize}&page=${page}`);

      return body.jobs || [];
    },
    limits,
  );

  return {
    checks: checksFromJobs(jobs.items),
    found: true,
    truncated: jobs.truncated,
    mismatch: null,
  };
}

export async function run(env, fetchImpl = globalThis.fetch, options = {}) {
  const limits = {
    maxPages: options.maxPages ?? MAX_PAGES,
    pageSize: options.pageSize ?? PAGE_SIZE,
  };
  const prNumber = parsePrNumber(env.PR_NUMBER);
  let number = prNumber.value;
  let loadedChecks = emptyChecks();

  if (prNumber.error) {
    return failure(loadedChecks, null, [prNumber.error]);
  }

  try {
    if (!env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN is missing");
    }

    if (!/^[^/\s]+\/[^/\s]+$/.test(env.REPO || "")) {
      throw new Error("REPO must be owner/name");
    }

    const headers = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    };
    const api = env.GITHUB_API_URL || "https://api.github.com";
    const gql = env.GITHUB_GRAPHQL_URL || `${api}/graphql`;
    const repo = env.REPO;

    async function get(path) {
      return getJson(`${api}${path}`, fetchImpl, headers);
    }

    async function list(path) {
      return fetchPagedList(async (page) => {
        const separator = path.includes("?") ? "&" : "?";

        return get(`${path}${separator}per_page=${limits.pageSize}&page=${page}`);
      }, limits);
    }

    if (!number && env.WORKFLOW_RUN_ID) {
      const triggered = await get(`/repos/${repo}/actions/runs/${encodeURIComponent(env.WORKFLOW_RUN_ID)}`);
      const pulls = await list(`/repos/${repo}/commits/${triggered.head_sha}/pulls`);

      if (pulls.truncated) {
        throw new Error("Pull request lookup for the head commit was truncated");
      }

      const match =
        pulls.items.find((item) => item.head?.sha === triggered.head_sha && item.state === "open") || pulls.items[0];

      if (match) {
        number = match.number;
      }
    }

    if (!number) {
      return failure(loadedChecks, null, ["No pull request or checks run to assess"]);
    }

    const pr = await get(`/repos/${repo}/pulls/${number}`);
    const headSha = pr.head.sha;
    const checksResult = await loadChecks(get, env, repo, headSha, limits);

    loadedChecks = checksResult.checks;

    const [commit, files, reviews, reviewComments, issueComments, events, threads] = await Promise.all([
      get(`/repos/${repo}/commits/${headSha}`),
      list(`/repos/${repo}/pulls/${number}/files`),
      list(`/repos/${repo}/pulls/${number}/reviews`),
      list(`/repos/${repo}/pulls/${number}/comments`),
      list(`/repos/${repo}/issues/${number}/comments`),
      list(`/repos/${repo}/issues/${number}/events`),
      fetchThreads(gql, headers, fetchImpl, repo, number, limits.maxPages),
    ]);

    return assess({
      checks: checksResult.checks,
      checksMissing: !checksResult.found && !checksResult.mismatch,
      checksTruncated: checksResult.truncated,
      checksMismatch: checksResult.mismatch,
      prNumber: number,
      pr,
      headCommittedAt: commit.commit?.committer?.date || "",
      files: files.items,
      filesTruncated: files.truncated,
      reviews: reviews.items,
      reviewsTruncated: reviews.truncated,
      reviewComments: reviewComments.items,
      reviewCommentsTruncated: reviewComments.truncated,
      issueComments: issueComments.items,
      issueCommentsTruncated: issueComments.truncated,
      events: events.items,
      eventsTruncated: events.truncated,
      threads: threads.threads,
      threadsTruncated: threads.truncated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return failure(loadedChecks, number, [
      `GitHub API request failed: ${message.split("\n")[0].slice(0, 300)}`,
      ...checkReasons(loadedChecks),
    ]);
  }
}

function isDirectRun() {
  const arg = process.argv[1];

  if (!arg) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const result = await run(process.env);

  publish(result);
}

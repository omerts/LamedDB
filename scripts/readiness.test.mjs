import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  assess,
  checksFromJobs,
  fetchPagedList,
  run,
} from "./readiness.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const HEAD_AT = "2026-11-23T12:00:00.000Z";
const AFTER = "2026-11-23T12:05:00.000Z";
const BEFORE = "2026-11-23T11:00:00.000Z";
const QODO = "qodo-code-review[bot]";

function input(overrides = {}) {
  return {
    checks: { install: "success", typecheck: "success", build: "success", tests: "success" },
    checksMissing: false,
    checksTruncated: false,
    checksMismatch: null,
    prNumber: 24,
    pr: {
      draft: false,
      head: { sha: HEAD },
      labels: [{ name: "Qodo approved" }],
    },
    headCommittedAt: HEAD_AT,
    files: [{ filename: "scripts/readiness.mjs" }],
    filesTruncated: false,
    reviews: [],
    reviewsTruncated: false,
    reviewComments: [],
    reviewCommentsTruncated: false,
    issueComments: [
      {
        user: { login: QODO },
        created_at: AFTER,
        updated_at: AFTER,
        body: `<!-- qodo-describe-head:${HEAD} -->`,
      },
    ],
    issueCommentsTruncated: false,
    events: [
      {
        event: "labeled",
        created_at: AFTER,
        actor: { login: QODO },
        label: { name: "Qodo approved" },
      },
    ],
    eventsTruncated: false,
    threads: [],
    threadsTruncated: false,
    ...overrides,
  };
}

function reason(result, pattern) {
  assert.equal(result.verdict, "NOT READY");
  assert.ok(
    result.reasons.some((item) => item.includes(pattern)),
    `missing ${pattern} in ${result.reasons.join(" | ")}`,
  );
}

describe("assess", () => {
  it("is READY when checks, Qodo, and the label all cover the head", () => {
    const result = assess(input());

    assert.equal(result.verdict, "READY");
    assert.equal(result.review.qodoCoversHead, true);
    assert.equal(result.review.qodoApprovedLabel, true);
  });

  it("accepts a Qodo review submitted on the head after that commit", () => {
    const result = assess(
      input({
        issueComments: [],
        reviews: [
          {
            user: { login: QODO, type: "Bot" },
            state: "COMMENTED",
            commit_id: HEAD,
            submitted_at: AFTER,
          },
        ],
      }),
    );

    assert.equal(result.verdict, "READY");
  });

  it("rejects a later review of an older commit", () => {
    const result = assess(
      input({
        issueComments: [],
        reviews: [
          {
            user: { login: QODO, type: "Bot" },
            state: "COMMENTED",
            commit_id: OTHER,
            submitted_at: AFTER,
          },
        ],
      }),
    );

    reason(result, "has not reviewed the latest commit");
    assert.equal(result.review.qodoReviewed, true);
    assert.equal(result.review.qodoCoversHead, false);
  });

  it("rejects a review of the head that is older than the commit", () => {
    const result = assess(
      input({
        issueComments: [],
        reviews: [
          {
            user: { login: QODO, type: "Bot" },
            state: "COMMENTED",
            commit_id: HEAD,
            submitted_at: BEFORE,
          },
        ],
      }),
    );

    reason(result, "has not reviewed the latest commit");
  });

  it("rejects an edited comment that does not name the head", () => {
    const result = assess(
      input({
        issueComments: [
          {
            user: { login: QODO },
            created_at: BEFORE,
            updated_at: AFTER,
            body: `<!-- qodo-describe-head:${OTHER} -->`,
          },
        ],
      }),
    );

    reason(result, "has not reviewed the latest commit");
  });

  it("accepts an edited comment that now names the head", () => {
    const result = assess(
      input({
        issueComments: [
          {
            user: { login: QODO },
            created_at: BEFORE,
            updated_at: AFTER,
            body: `reviewed ${HEAD}`,
          },
        ],
      }),
    );

    assert.equal(result.verdict, "READY");
  });

  it("rejects a comment that names the head but was not updated after it", () => {
    const result = assess(
      input({
        issueComments: [
          {
            user: { login: QODO },
            created_at: BEFORE,
            updated_at: BEFORE,
            body: HEAD,
          },
        ],
      }),
    );

    reason(result, "has not reviewed the latest commit");
  });

  it("rejects a label applied before the head commit", () => {
    const result = assess(
      input({
        events: [
          {
            event: "labeled",
            created_at: BEFORE,
            actor: { login: QODO },
            label: { name: "Qodo approved" },
          },
        ],
      }),
    );

    reason(result, "older than the latest commit");
    assert.equal(result.review.qodoApprovedLabel, false);
  });

  it("rejects a label applied by a person", () => {
    const result = assess(
      input({
        events: [
          {
            event: "labeled",
            created_at: AFTER,
            actor: { login: "omerts" },
            label: { name: "Qodo approved" },
          },
        ],
      }),
    );

    reason(result, "was not applied by Qodo");
  });

  it("counts an unresolved outdated thread", () => {
    const result = assess(
      input({
        threads: [
          {
            isResolved: false,
            isOutdated: true,
            path: "scripts/readiness.mjs",
            comments: { nodes: [{ author: { login: QODO }, body: "still open", url: "https://example.test/c" }] },
          },
        ],
      }),
    );

    reason(result, "1 unresolved review thread");
    assert.equal(result.review.unresolvedThreads[0].outdated, true);
  });

  it("ignores a resolved thread", () => {
    const result = assess(
      input({
        threads: [{ isResolved: true, isOutdated: true, path: "scripts/readiness.mjs", comments: { nodes: [] } }],
      }),
    );

    assert.equal(result.verdict, "READY");
  });

  it("fails closed when a later page of threads was not fetched", () => {
    const result = assess(input({ threadsTruncated: true }));

    reason(result, "Review thread list is incomplete");
  });

  it("fails closed when the file list is truncated, even if no guarded path was seen", () => {
    const result = assess(input({ filesTruncated: true, files: [{ filename: "README.md" }] }));

    reason(result, "PR file list is incomplete");
  });

  it("requires a human approval when a guarded path is renamed", () => {
    const result = assess(
      input({
        files: [{ filename: "docs/server.ts", previous_filename: "src/http/server.ts" }],
      }),
    );

    reason(result, "src/http/");
  });

  it("accepts a human approval of the head when src/http changes", () => {
    const result = assess(
      input({
        files: [{ filename: "src/http/server.ts" }],
        reviews: [
          {
            user: { login: "omerts", type: "User" },
            state: "APPROVED",
            commit_id: HEAD,
            submitted_at: AFTER,
          },
        ],
      }),
    );

    assert.equal(result.verdict, "READY");
    assert.deepEqual(result.review.humanApprovals, ["omerts"]);
  });

  it("does not treat an approval of an older commit as approval of the head", () => {
    const result = assess(
      input({
        files: [{ filename: "src/http/server.ts" }],
        reviews: [
          {
            user: { login: "omerts", type: "User" },
            state: "APPROVED",
            commit_id: OTHER,
            submitted_at: AFTER,
          },
        ],
      }),
    );

    reason(result, "human approval");
  });

  it("records an install failure as NOT READY", () => {
    const result = assess(input({ checks: { install: "failure", typecheck: "skipped", build: "skipped", tests: "skipped" } }));

    reason(result, 'Check "install" failure');
    reason(result, 'Check "tests" skipped');
  });

  it("turns a checks API failure into NOT READY without throwing", async () => {
    const result = await run(
      { GITHUB_TOKEN: "token", REPO: "acme/db", PR_NUMBER: "24" },
      async () => ({ ok: false, status: 503, json: async () => ({}) }),
    );

    reason(result, "GitHub API request failed: GET /repos/acme/db/pulls/24 -> 503");
    assert.equal(result.verdict, "NOT READY");
  });
});

describe("pagination", () => {
  it("stops on a short page and reports a full cap as truncated", async () => {
    const complete = await fetchPagedList(async (page) => (page === 1 ? ["a", "b"] : []), { maxPages: 3, pageSize: 2 });
    const truncated = await fetchPagedList(async () => ["a", "b"], { maxPages: 2, pageSize: 2 });

    assert.deepEqual(complete, { items: ["a", "b"], truncated: false });
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.items.length, 4);
  });

  it("reads a guarded file that is not on the first page", async () => {
    const calls = [];
    const result = await run(
      {
        GITHUB_TOKEN: "token",
        REPO: "acme/db",
        PR_NUMBER: "24",
        GITHUB_API_URL: "https://api.example.test",
        GITHUB_GRAPHQL_URL: "https://api.example.test/graphql",
      },
      async (url, options = {}) => {
        calls.push(String(url));
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page") || "1");
        let body = [];

        if (options.method === "POST") {
          body = {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          };
        } else if (parsed.pathname.endsWith("/pulls/24/files")) {
          body = page === 1
            ? [{ filename: "README.md" }, { filename: "package.json" }]
            : [{ filename: "src/http/server.ts" }];
        } else if (parsed.pathname.endsWith("/pulls/24/reviews") || parsed.pathname.endsWith("/pulls/24/comments")) {
          body = [];
        } else if (parsed.pathname.endsWith("/issues/24/comments")) {
          body = [
            {
              user: { login: QODO },
              created_at: AFTER,
              updated_at: AFTER,
              body: `<!-- qodo-describe-head:${HEAD} -->`,
            },
          ];
        } else if (parsed.pathname.endsWith("/issues/24/events")) {
          body = [
            {
              event: "labeled",
              created_at: AFTER,
              actor: { login: QODO },
              label: { name: "Qodo approved" },
            },
          ];
        } else if (parsed.pathname.endsWith("/pulls/24")) {
          body = { draft: false, head: { sha: HEAD }, labels: [{ name: "Qodo approved" }] };
        } else if (parsed.pathname.endsWith(`/commits/${HEAD}`)) {
          body = { commit: { committer: { date: HEAD_AT } } };
        } else if (parsed.pathname.endsWith("/runs")) {
          body = {
            workflow_runs: [{ id: 9, head_sha: HEAD, path: ".github/workflows/readiness-checks.yml" }],
          };
        } else if (parsed.pathname.endsWith("/jobs")) {
          body = {
            jobs: [
              {
                name: "checks",
                steps: [
                  { name: "Install", conclusion: "success" },
                  { name: "Typecheck", conclusion: "success" },
                  { name: "Build", conclusion: "success" },
                  { name: "Tests", conclusion: "success" },
                ],
              },
            ],
          };
        } else {
          throw new Error(`unexpected ${url}`);
        }

        return { ok: true, status: 200, json: async () => body };
      },
      { maxPages: 5, pageSize: 2 },
    );

    reason(result, "src/http/");
    assert.deepEqual(result.review.guardedFiles, ["src/http/server.ts"]);
    assert.ok(calls.some((url) => url.includes("/files") && url.includes("page=2")));
  });

  it("fails closed when review threads keep paging", async () => {
    const result = await run(
      {
        GITHUB_TOKEN: "token",
        REPO: "acme/db",
        PR_NUMBER: "24",
        GITHUB_API_URL: "https://api.example.test",
        GITHUB_GRAPHQL_URL: "https://api.example.test/graphql",
      },
      async (url, options = {}) => {
        const parsed = new URL(url);
        let body = [];

        if (options.method === "POST") {
          body = {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: true, endCursor: "next" },
                    nodes: [{ isResolved: true, isOutdated: false, path: "README.md", comments: { nodes: [] } }],
                  },
                },
              },
            },
          };
        } else if (parsed.pathname.endsWith("/pulls/24")) {
          body = { draft: false, head: { sha: HEAD }, labels: [] };
        } else if (parsed.pathname.endsWith(`/commits/${HEAD}`)) {
          body = { commit: { committer: { date: HEAD_AT } } };
        } else if (parsed.pathname.endsWith("/runs")) {
          body = { workflow_runs: [] };
        } else if (parsed.pathname.endsWith("/jobs")) {
          body = { jobs: [] };
        }

        return { ok: true, status: 200, json: async () => body };
      },
      { maxPages: 1, pageSize: 1 },
    );

    reason(result, "Review thread list is incomplete");
  });
});

describe("check steps", () => {
  it("maps install, typecheck, build, and tests, and ignores other steps", () => {
    const checks = checksFromJobs([
      {
        name: "checks",
        steps: [
          { name: "Run actions/checkout@v4", conclusion: "success" },
          { name: "Install", conclusion: "failure" },
          { name: "Typecheck", conclusion: "skipped" },
          { name: "Build", status: "in_progress" },
          { name: "Tests" },
        ],
      },
    ]);

    assert.deepEqual(checks, {
      install: "failure",
      typecheck: "skipped",
      build: "in_progress",
      tests: "missing",
    });
  });
});

describe("workflow trust boundary", () => {
  const checks = readFileSync(new URL("../.github/workflows/readiness-checks.yml", import.meta.url), "utf8");
  const verdict = readFileSync(new URL("../.github/workflows/readiness.yml", import.meta.url), "utf8");

  it("runs repository code only in the untrusted checks job", () => {
    assert.match(checks, /persist-credentials:\s*false/);
    assert.match(checks, /GITHUB_TOKEN:\s*""/);
    assert.doesNotMatch(checks, /scripts\/readiness\.mjs/);
    assert.doesNotMatch(checks, /contents:\s*write/);
    assert.equal(checks.includes("workflow_dispatch"), false);
  });

  it("computes the verdict from the default branch without a pull_request checkout", () => {
    assert.match(verdict, /workflow_run:/);
    assert.match(verdict, /pull_request_target:/);
    assert.match(verdict, /issue_comment:/);
    assert.match(verdict, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
    assert.match(verdict, /persist-credentials:\s*false/);
    assert.doesNotMatch(verdict, /github\.event\.pull_request\.head/);
    assert.equal(/^\s*pull_request:\s*$/m.test(verdict), false);
    assert.doesNotMatch(verdict, /contents:\s*write/);
    assert.doesNotMatch(verdict, /pull-requests:\s*write/);
  });
});

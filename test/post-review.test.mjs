import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findExistingReview, postReview } from "../scripts/post-review.mjs";
import { marker } from "../scripts/render.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const bot = "github-actions[bot]";

function review(overrides = {}) {
  return {
    id: 1,
    state: "COMMENTED",
    user: { login: bot, type: "Bot" },
    body: `text\n\n${marker(head, base)}`,
    submitted_at: "2026-11-22T00:00:00Z",
    ...overrides,
  };
}

function fakeClient(overrides = {}) {
  const calls = { createReview: [], updateReview: [] };
  return {
    calls,
    getReviews: async () => [review()],
    getPull: async () => ({ head: { sha: head } }),
    createReview: async (_pull, payload) => {
      calls.createReview.push(payload);
      return { id: 10 };
    },
    updateReview: async (...args) => {
      calls.updateReview.push(args);
      return {};
    },
    ...overrides,
  };
}

describe("findExistingReview", () => {
  test("matches the latest bot review with the exact marker", () => {
    const found = findExistingReview([review()], bot, head, base);
    assert.equal(found.id, 1);
  });

  test("ignores another user, a quoted marker, and an older marker", () => {
    assert.equal(
      findExistingReview(
        [review({ user: { login: "human" } })],
        bot,
        head,
        base,
      ),
      undefined,
    );
    assert.equal(
      findExistingReview(
        [review({ body: `> ${marker(head, base)}` })],
        bot,
        head,
        base,
      ),
      undefined,
    );
    assert.equal(
      findExistingReview(
        [
          review({ id: 1, submitted_at: "2026-11-21T00:00:00Z" }),
          review({
            id: 2,
            body: "new review",
            submitted_at: "2026-11-22T00:00:00Z",
          }),
        ],
        bot,
        head,
        base,
      ),
      undefined,
    );
  });
});

describe("postReview", () => {
  test("skips the same head unless force", async () => {
    const client = fakeClient();
    const result = await postReview({
      client,
      pullNumber: 1,
      headSha: head,
      baseSha: base,
      body: "body",
      findings: [],
      force: false,
      dryRun: false,
      botLogin: bot,
    });
    assert.equal(result.skipped, true);
    assert.equal(client.calls.createReview.length, 0);
  });

  test("skips a moved head", async () => {
    const client = fakeClient({
      getReviews: async () => [],
      getPull: async () => ({ head: { sha: "c".repeat(40) } }),
    });
    const result = await postReview({
      client,
      pullNumber: 1,
      headSha: head,
      baseSha: base,
      body: "body",
      findings: [],
      force: false,
      dryRun: false,
      botLogin: bot,
    });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /head moved/);
  });

  test("does not call the API in dry-run", async () => {
    const client = fakeClient({ getReviews: async () => [] });
    const result = await postReview({
      client,
      pullNumber: 1,
      headSha: head,
      baseSha: base,
      body: "body",
      findings: [{ path: "a", line: 1, body: "x" }],
      force: false,
      dryRun: true,
      botLogin: bot,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.findings, 1);
    assert.equal(client.calls.createReview.length, 0);
  });

  test("falls back to a summary-only review on 422", async () => {
    let calls = 0;
    const client = fakeClient({
      getReviews: async () => [],
      createReview: async (_pull, payload) => {
        calls += 1;
        if (calls === 1)
          throw {
            status: 422,
            message: "Unprocessable Entity",
            details: ["Line could not be resolved"],
          };
        assert.deepEqual(payload.comments, []);
        assert.match(payload.body, /1 inline comments omitted/);
        return { id: 11 };
      },
    });
    const result = await postReview({
      client,
      pullNumber: 1,
      headSha: head,
      baseSha: base,
      body: `## OpenCode review\n\n${marker(head, base)}`,
      findings: [{ path: "a", line: 1, body: "x" }],
      force: false,
      dryRun: false,
      botLogin: bot,
    });
    assert.equal(result.fallback, true);
    assert.equal(result.reviewId, 11);
  });

  test("updates the old review body after a forced post", async () => {
    const client = fakeClient();
    const result = await postReview({
      client,
      pullNumber: 1,
      headSha: head,
      baseSha: base,
      body: "body",
      findings: [],
      force: true,
      dryRun: false,
      botLogin: bot,
    });
    assert.equal(result.reviewId, 10);
    assert.equal(client.calls.updateReview.length, 1);
  });
});

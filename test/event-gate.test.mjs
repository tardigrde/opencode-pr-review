import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { eventSkipReason } from "../scripts/main.mjs";

const env = {
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REPOSITORY: "owner/repo",
};

function pr(overrides = {}) {
  return {
    number: 1,
    draft: false,
    user: { type: "User" },
    head: { sha: "a".repeat(40), repo: { full_name: "owner/repo" } },
    base: { sha: "b".repeat(40) },
    ...overrides,
  };
}

describe("eventSkipReason", () => {
  test("accepts a same-repo PR", () => {
    assert.equal(eventSkipReason({ pull_request: pr() }, env), undefined);
  });

  test("skips forks", () => {
    assert.match(
      eventSkipReason(
        {
          pull_request: pr({
            head: { sha: "a", repo: { full_name: "fork/repo" } },
          }),
        },
        env,
      ),
      /fork/,
    );
  });

  test("skips drafts and bots", () => {
    assert.match(
      eventSkipReason({ pull_request: pr({ draft: true }) }, env),
      /draft/,
    );
    assert.match(
      eventSkipReason({ pull_request: pr({ user: { type: "Bot" } }) }, env),
      /bot/,
    );
  });

  test("skips a missing payload", () => {
    assert.match(eventSkipReason({}, env), /missing/);
  });

  test("skips a wrong event", () => {
    assert.match(
      eventSkipReason(
        { pull_request: pr() },
        { ...env, GITHUB_EVENT_NAME: "push" },
      ),
      /pull_request/,
    );
  });

  test("skips missing SHAs", () => {
    assert.match(
      eventSkipReason(
        { pull_request: pr({ head: { repo: { full_name: "owner/repo" } } }) },
        env,
      ),
      /SHA/,
    );
  });
});

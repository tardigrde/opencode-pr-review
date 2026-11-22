import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  emptyUsage,
  formatUsageLine,
  parseUsage,
  renderUsageSummary,
} from "../scripts/usage.mjs";

const finish = (tokens, cost) =>
  JSON.stringify({
    type: "step_finish",
    part: { type: "step-finish", reason: "stop", cost, tokens },
  });

describe("parseUsage", () => {
  test("sums every step_finish event", () => {
    const usage = parseUsage(
      [
        "not json",
        '{"type":"text","part":{"text":"x"}}',
        finish(
          {
            input: 100,
            output: 5,
            reasoning: 2,
            cache: { read: 10, write: 1 },
          },
          0.5,
        ),
        finish({ input: 40, output: 3, reasoning: 0, cache: { read: 4 } }, 0),
      ].join("\n"),
    );
    assert.deepEqual(usage, {
      steps: 2,
      input: 140,
      output: 8,
      reasoning: 2,
      cacheRead: 14,
      cacheWrite: 1,
      cost: 0.5,
    });
  });

  test("ignores missing or invalid fields", () => {
    const usage = parseUsage(
      [
        '{"type":"step_finish","part":{"reason":"stop"}}',
        finish({ input: "x", output: -3, cache: null }, "free"),
      ].join("\n"),
    );
    assert.deepEqual(usage, { ...emptyUsage(), steps: 2 });
  });

  test("returns zeros for empty output", () => {
    assert.deepEqual(parseUsage(""), emptyUsage());
  });
});

describe("usage text", () => {
  const usage = { ...emptyUsage(), steps: 1, input: 10328, output: 3 };

  test("formats one log line", () => {
    assert.equal(
      formatUsageLine(usage, 41),
      "opencode-pr-review: usage: 10328 input tokens, 3 output tokens, 0 reasoning tokens, 0 cache read, 0 cache write, 41s",
    );
  });

  test("renders a step summary table", () => {
    const text = renderUsageSummary({
      model: "p/m",
      usage,
      durationSeconds: 41,
    });
    assert.match(text, /^### OpenCode review usage/);
    assert.match(text, /\| Model \| p\/m \|/);
    assert.match(text, /\| Input tokens \| 10328 \|/);
    assert.match(text, /\| Duration \(seconds\) \| 41 \|/);
  });
});

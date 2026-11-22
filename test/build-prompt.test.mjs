import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildPrompt,
  capDiffLines,
  capText,
} from "../scripts/build-prompt.mjs";

describe("buildPrompt", () => {
  test("includes untrusted data, limits, and the schema", () => {
    const prompt = buildPrompt({
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      pr: { number: 7, title: "Fix pagination", body: "Body text" },
      diff: "@@ -1 +1 @@\n-a\n+b",
      customPrompt: "Focus on security.",
      maxFindings: 3,
      severityThreshold: "high",
      nonce: "abc123",
    });
    assert.match(prompt, /<untrusted-abc123>/);
    assert.match(prompt, /<\/untrusted-abc123>/);
    assert.match(prompt, /Fix pagination/);
    assert.match(prompt, /Focus on security\./);
    assert.match(prompt, /Maximum findings: 3/);
    assert.match(prompt, /Severity threshold: high/);
    assert.match(prompt, /"findings"/);
    assert.doesNotMatch(prompt, /"summary"/);
  });

  test("caps PR body and long diff lines", () => {
    const prompt = buildPrompt({
      baseSha: "b",
      headSha: "a",
      pr: { number: 1, title: "t", body: "x".repeat(9000) },
      diff: `+${"y".repeat(3000)}`,
      customPrompt: "",
      maxFindings: 20,
      severityThreshold: "medium",
      nonce: "n",
    });
    assert.equal(prompt.includes("x".repeat(8001)), false);
    assert.match(prompt, /y{1000,}…/);
  });
});

describe("cap helpers", () => {
  test("capText and capDiffLines", () => {
    assert.equal(capText("abcdef", 4), "abc…");
    assert.equal(capDiffLines("+" + "x".repeat(10), 5), "+xxxx…");
  });
});

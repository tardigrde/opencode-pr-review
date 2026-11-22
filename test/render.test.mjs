import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatOmitted,
  marker,
  renderComment,
  renderSummary,
  sanitizeInline,
} from "../scripts/render.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const emptyOmitted = {
  invalidAnchor: 0,
  invalidData: 0,
  duplicate: 0,
  belowThreshold: 0,
  overLimit: 0,
};

describe("renderComment", () => {
  test("renders the exact inline body", () => {
    const body = renderComment({
      severity: "high",
      title: "Pagination drops the last item",
      problem: "When page is the last page, page + 1 returns an empty list.",
      fix: "Clamp the index to items.length - 1.",
    });
    assert.equal(
      body,
      "**High — Pagination drops the last item**\n\nWhen page is the last page, page + 1 returns an empty list.\n\n**Fix:** Clamp the index to items.length - 1.",
    );
  });

  test("strips images, links, HTML, and mentions", () => {
    const text = sanitizeInline(
      "![x](https://a) [click](https://b) <b>hi</b> @team",
    );
    assert.equal(text.includes("https://a"), false);
    assert.equal(text.includes("https://b"), false);
    assert.equal(text.includes("<b>"), false);
    assert.equal(text.includes("@team"), false);
  });

  test("keeps code spans readable", () => {
    assert.equal(
      sanitizeInline("Use `a && b` and `my_var` not `@scope/pkg`."),
      "Use `a && b` and `my_var` not `@scope/pkg`.",
    );
    assert.equal(sanitizeInline("a_b & `x_y`"), "a\\_b &amp; `x_y`");
  });

  test("does not trust escaped or repeated backticks", () => {
    for (const input of [
      "\\`<b>x</b>\\`",
      "``<b>x</b>`",
      "`[click](https://evil.example)``",
    ]) {
      const text = sanitizeInline(input);
      assert.equal(text.includes("<b>"), false, input);
      assert.equal(text.includes("](https"), false, input);
    }
  });

  test("a cut never leaves a code span open", () => {
    const body = renderComment({
      severity: "low",
      title: "t",
      problem: `${"y".repeat(962)} \`<b>x</b> tail\``,
      fix: "f",
    });
    const open = [...body.matchAll(/(?<!\\)`/g)].length;
    assert.equal(open % 2, 0);
    assert.equal(body.includes("<b>"), false);
  });
});

describe("formatOmitted", () => {
  test("uses singular and plural forms", () => {
    assert.equal(
      formatOmitted({ ...emptyOmitted, invalidAnchor: 1 }),
      "1 finding omitted (1 invalid anchor).",
    );
    assert.equal(
      formatOmitted({ ...emptyOmitted, invalidAnchor: 1, duplicate: 2 }),
      "3 findings omitted (1 invalid anchor, 2 duplicate).",
    );
  });
});

describe("renderSummary", () => {
  test("renders counts and the marker", () => {
    const body = renderSummary({
      findings: [
        { severity: "high" },
        { severity: "medium" },
        { severity: "medium" },
      ],
      omitted: emptyOmitted,
      truncated: 0,
      headSha: head,
      baseSha: base,
    });
    assert.equal(
      body,
      `## OpenCode review\n\n1 high, 2 medium. See inline comments.\n\n${marker(head, base)}`,
    );
  });

  test("renders the clean body", () => {
    const body = renderSummary({
      findings: [],
      omitted: emptyOmitted,
      truncated: 0,
      headSha: head,
      baseSha: base,
    });
    assert.equal(
      body,
      `## OpenCode review\n\nNo actionable findings in this pass.\n\n${marker(head, base)}`,
    );
  });

  test("renders omissions and no-added-lines notes", () => {
    const body = renderSummary({
      findings: [],
      omitted: { ...emptyOmitted, invalidAnchor: 1 },
      truncated: 2,
      headSha: head,
      baseSha: base,
      noAddedLines: true,
    });
    assert.match(body, /No added lines to review\./);
    assert.match(body, /1 finding omitted \(1 invalid anchor\)\./);
    assert.match(body, /2 findings truncated\./);
    assert.equal(body.trim().split("\n").at(-1), marker(head, base));
  });
});

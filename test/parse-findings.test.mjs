import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  extractJson,
  ModelOutputError,
  validateFindings,
} from "../scripts/parse-findings.mjs";

function maps() {
  const localMap = new Map([["src/a.ts", new Set([1, 2, 3, 10])]]);
  const githubMap = new Map([["src/a.ts", new Set([1, 2, 3, 10])]]);
  return { localMap, githubMap };
}

function finding(overrides = {}) {
  return {
    path: "src/a.ts",
    line: 2,
    severity: "high",
    title: "Bug",
    problem: "It fails.",
    fix: "Fix it.",
    ...overrides,
  };
}

describe("extractJson", () => {
  test("parses plain JSON", () => {
    assert.deepEqual(extractJson('{"findings":[]}'), { findings: [] });
  });

  test("parses JSON in a code fence", () => {
    assert.deepEqual(extractJson('```json\n{"findings":[]}\n```'), {
      findings: [],
    });
  });

  test("ignores trailing prose with braces", () => {
    assert.deepEqual(extractJson('{"findings":[]}\nNote: use {curly braces}'), {
      findings: [],
    });
  });

  test("skips a trailing non-schema object and finds the review object", () => {
    const text = '{"findings":[]}\n{"status":"ok"}';
    assert.deepEqual(extractJson(text), { findings: [] });
  });

  test("rejects text with only non-schema objects", () => {
    const text = '{"summary":"x"}\n{"status":"ok"}';
    assert.throws(() => extractJson(text), ModelOutputError);
  });

  test("respects braces inside strings", () => {
    assert.deepEqual(extractJson('{"findings":[],"note":"a } b"}'), {
      findings: [],
      note: "a } b",
    });
  });

  test("rejects an object without findings", () => {
    assert.throws(() => extractJson('{"summary":"clean"}'), ModelOutputError);
  });
});

describe("validateFindings", () => {
  test("keeps a valid finding", () => {
    const result = validateFindings(
      { findings: [finding()] },
      { ...maps(), severityThreshold: "medium", maxFindings: 20 },
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].line, 2);
  });

  test("drops an invalid anchor", () => {
    const result = validateFindings(
      { findings: [finding({ line: 99 })] },
      { ...maps(), severityThreshold: "medium", maxFindings: 20 },
    );
    assert.equal(result.findings.length, 0);
    assert.equal(result.omitted.invalidAnchor, 1);
  });

  test("drops invalid data", () => {
    const result = validateFindings(
      { findings: [finding({ severity: "urgent" })] },
      { ...maps(), severityThreshold: "medium", maxFindings: 20 },
    );
    assert.equal(result.findings.length, 0);
    assert.equal(result.omitted.invalidData, 1);
  });

  test("drops only an invalid start_line", () => {
    const result = validateFindings(
      { findings: [finding({ start_line: 99 })] },
      { ...maps(), severityThreshold: "medium", maxFindings: 20 },
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].start_line, undefined);
  });

  test("keeps the high duplicate when the low one comes first", () => {
    const result = validateFindings(
      {
        findings: [
          finding({ severity: "low" }),
          finding({
            severity: "high",
            problem: "A much longer problem that should win.",
          }),
        ],
      },
      { ...maps(), severityThreshold: "medium", maxFindings: 20 },
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "high");
    assert.equal(result.omitted.duplicate, 1);
  });

  test("applies the threshold and cap", () => {
    const result = validateFindings(
      {
        findings: [
          finding({ line: 1, severity: "low" }),
          finding({ line: 2, severity: "high" }),
          finding({ line: 3, severity: "medium" }),
        ],
      },
      { ...maps(), severityThreshold: "medium", maxFindings: 1 },
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "high");
    assert.equal(result.omitted.belowThreshold, 1);
    assert.equal(result.omitted.overLimit, 1);
  });

  test("truncates long fields and counts it", () => {
    const result = validateFindings(
      {
        findings: [
          finding({
            title: "x".repeat(200),
            problem: "y".repeat(900),
            fix: "z".repeat(500),
          }),
        ],
      },
      { ...maps(), severityThreshold: "medium", maxFindings: 20 },
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.truncated, 1);
    assert.ok(result.findings[0].title.length <= 72);
    assert.ok(result.findings[0].problem.length <= 560);
    assert.ok(result.findings[0].fix.length <= 280);
  });

  test("rejects a non-array findings value", () => {
    assert.throws(
      () =>
        validateFindings(
          { findings: {} },
          { ...maps(), severityThreshold: "medium", maxFindings: 20 },
        ),
      ModelOutputError,
    );
  });
});

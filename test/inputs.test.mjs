import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InputError, readInputs } from "../scripts/inputs.mjs";

const baseEnv = {
  INPUT_OPENCODE_API_KEY: "oc_test_key",
  INPUT_GITHUB_TOKEN: "gh_test_token",
};

describe("readInputs", () => {
  test("applies defaults", () => {
    const inputs = readInputs(baseEnv);
    assert.equal(inputs.model, "opencode-go/deepseek-v4.1-flash");
    assert.equal(inputs.maxFindings, 20);
    assert.equal(inputs.severityThreshold, "medium");
    assert.equal(inputs.maxDiffBytes, 300000);
    assert.equal(inputs.timeoutSeconds, 1500);
    assert.equal(inputs.dryRun, false);
    assert.equal(inputs.force, false);
    assert.equal(inputs.opencodeVersion, "2.3.2");
  });

  test("parses exact booleans", () => {
    const inputs = readInputs({
      ...baseEnv,
      INPUT_DRY_RUN: "true",
      INPUT_FORCE: "false",
    });
    assert.equal(inputs.dryRun, true);
    assert.equal(inputs.force, false);
    assert.throws(
      () => readInputs({ ...baseEnv, INPUT_DRY_RUN: "1" }),
      InputError,
    );
  });

  test("requires a token unless dry-run", () => {
    assert.throws(
      () => readInputs({ INPUT_OPENCODE_API_KEY: "oc_test_key" }),
      /github-token is required/,
    );
    const inputs = readInputs({
      INPUT_OPENCODE_API_KEY: "oc_test_key",
      INPUT_DRY_RUN: "true",
    });
    assert.equal(inputs.githubToken, "");
  });

  test("rejects ambiguous prompt inputs", () => {
    assert.throws(
      () =>
        readInputs({
          ...baseEnv,
          INPUT_PROMPT: "text",
          INPUT_PROMPT_FILE: "p.md",
        }),
      /prompt or prompt-file/,
    );
  });

  test("rejects an unsafe prompt-file path", () => {
    assert.throws(
      () => readInputs({ ...baseEnv, INPUT_PROMPT_FILE: "../p.md" }),
      /must not contain/,
    );
    assert.throws(
      () => readInputs({ ...baseEnv, INPUT_PROMPT_FILE: "/p.md" }),
      /must be relative/,
    );
  });

  test("rejects invalid numeric and enum inputs", () => {
    assert.throws(
      () => readInputs({ ...baseEnv, INPUT_MAX_FINDINGS: "0" }),
      InputError,
    );
    assert.throws(
      () => readInputs({ ...baseEnv, INPUT_MAX_FINDINGS: "abc" }),
      InputError,
    );
    assert.throws(
      () => readInputs({ ...baseEnv, INPUT_SEVERITY_THRESHOLD: "HIGH" }),
      InputError,
    );
    assert.throws(
      () => readInputs({ ...baseEnv, INPUT_OPENCODE_VERSION: "latest" }),
      InputError,
    );
  });
});

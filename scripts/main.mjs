import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readInputs } from "./inputs.mjs";
import { GitHubClient } from "./github.mjs";
import { registerSecret, redact, redactError } from "./redact.mjs";
import {
  checkGitCredentials,
  collectDiff,
  parseGitHubFiles,
  readBaseFile,
  validateRepo,
} from "./collect-diff.mjs";
import { createSandbox, cleanupSandbox } from "./sandbox.mjs";
import { buildPrompt } from "./build-prompt.mjs";
import { runOpencode } from "./run-opencode.mjs";
import { extractJson, validateFindings } from "./parse-findings.mjs";
import { renderComment, renderSummary } from "./render.mjs";
import { findExistingReview, postReview } from "./post-review.mjs";

const ZERO_OMITTED = {
  invalidAnchor: 0,
  invalidData: 0,
  duplicate: 0,
  belowThreshold: 0,
  overLimit: 0,
};

/**
 * @param {string} name
 * @param {string | number | boolean} value
 */
export function setOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  const line = `${name}=${value}`;
  if (output) fs.appendFileSync(output, `${line}\n`);
  else console.log(line);
}

/**
 * @param {string} reason
 */
function skip(reason) {
  console.log(`opencode-pr-review: skipped (${reason})`);
  setOutput("findings", 0);
  setOutput("review_id", "");
  setOutput("posted", "false");
  setOutput("skipped", "true");
  setOutput("omitted", 0);
  return 0;
}

/**
 * @returns {any}
 */
function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  try {
    return JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * @param {any} event
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function eventSkipReason(event, env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request")
    return "event is not pull_request";
  const pr = event?.pull_request;
  if (!pr) return "missing pull_request payload";
  if (pr.draft !== false) return "pull request is a draft";
  if (pr.user?.type === "Bot") return "pull request author is a bot";
  if (pr.head?.repo?.full_name !== env.GITHUB_REPOSITORY)
    return "pull request is from a fork";
  if (!pr.head?.sha || !pr.base?.sha) return "missing head or base SHA";
  if (!Number.isInteger(pr.number)) return "missing pull request number";
  return undefined;
}

/**
 * @param {any} event
 * @returns {string}
 */
function defaultPrompt() {
  return fs.readFileSync(
    path.resolve(import.meta.dirname, "../prompt.md"),
    "utf8",
  );
}

/**
 * @param {{status: number, message: string, details?: unknown}} error
 * @returns {string}
 */
function githubErrorText(error) {
  const details = Array.isArray(error.details)
    ? ` (${error.details.join("; ")})`
    : "";
  return `GitHub API ${error.status}: ${error.message}${details}`;
}

export async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 24) {
    throw new Error(
      `Node.js 24 or newer is required (found ${process.versions.node})`,
    );
  }

  const event = readEvent();
  const skipReason = eventSkipReason(event, process.env);
  if (skipReason) return skip(skipReason);

  const inputs = readInputs();
  registerSecret(inputs.apiKey);
  registerSecret(inputs.githubToken);

  const pr = event.pull_request;
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const headSha = pr.head.sha;
  const baseSha = pr.base.sha;
  const pullNumber = pr.number;

  if (!process.env.GITHUB_REPOSITORY)
    throw new Error("GITHUB_REPOSITORY is not set");

  validateRepo({ workspace, baseSha, headSha });
  checkGitCredentials(workspace);

  let local = await collectDiff({
    workspace,
    baseSha,
    headSha,
    maxBytes: inputs.maxDiffBytes,
  });

  const client = new GitHubClient({
    token: inputs.githubToken,
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL,
  });

  const pull = await client.getPull(pullNumber);
  if (pull?.head?.sha !== headSha) {
    return skip(
      `head moved from ${headSha} to ${pull?.head?.sha ?? "unknown"}`,
    );
  }

  const files = await client.getPullFiles(pullNumber);
  const github = parseGitHubFiles(files);

  const botLogin = await client.getBotLogin();
  const reviews = await client.getReviews(pullNumber);
  if (
    !inputs.force &&
    findExistingReview(reviews, botLogin, headSha, baseSha)
  ) {
    return skip("review marker already exists at this head");
  }

  const hiddenPaths = [...github.map]
    .filter(([pathName, lines]) => {
      if (lines.size === 0) return false;
      const localLines = local.map.get(pathName);
      return !localLines || [...lines].some((line) => !localLines.has(line));
    })
    .map(([pathName]) => pathName);
  if (hiddenPaths.length > 0) {
    const textDiff = await collectDiff({
      workspace,
      baseSha,
      headSha,
      maxBytes: inputs.maxDiffBytes,
      text: true,
      paths: hiddenPaths,
    });
    const merged = new Map(local.map);
    for (const [pathName, lines] of textDiff.map) {
      const existing = merged.get(pathName) ?? new Set();
      for (const line of lines) existing.add(line);
      merged.set(pathName, existing);
    }
    local = {
      text: `${local.text}\n${textDiff.text}`,
      map: merged,
      binaryFiles: new Set([...local.binaryFiles, ...textDiff.binaryFiles]),
    };
  }

  if (local.map.size === 0) {
    const body = renderSummary({
      findings: [],
      omitted: ZERO_OMITTED,
      truncated: 0,
      headSha,
      baseSha,
      noAddedLines: true,
    });
    const result = await postReview({
      client,
      pullNumber,
      headSha,
      baseSha,
      body,
      findings: [],
      force: inputs.force,
      dryRun: inputs.dryRun,
      botLogin,
    });
    return finish(result, 0);
  }

  let customPrompt;
  if (inputs.promptFile) {
    customPrompt = readBaseFile(workspace, baseSha, inputs.promptFile);
  } else if (inputs.prompt) {
    customPrompt = inputs.prompt;
  } else {
    customPrompt = defaultPrompt();
  }

  const prompt = buildPrompt({
    baseSha,
    headSha,
    pr,
    diff: local.text,
    customPrompt,
    maxFindings: inputs.maxFindings,
    severityThreshold: inputs.severityThreshold,
  });

  const sandbox = createSandbox({ workspace, model: inputs.model });
  let modelText;
  try {
    const bin =
      process.env.OPENCODE_BIN ??
      path.join(
        process.env.RUNNER_TEMP ?? os.tmpdir(),
        "opencode-cli",
        "bin",
        "opencode",
      );
    modelText = await runOpencode({
      bin,
      model: inputs.model,
      prompt,
      configContent: sandbox.configContent,
      apiKey: inputs.apiKey,
      runDir: sandbox.run,
      home: sandbox.home,
      config: sandbox.config,
      data: sandbox.data,
      cache: sandbox.cache,
      configDir: sandbox.configDir,
      timeoutSeconds: inputs.timeoutSeconds,
    });
  } finally {
    cleanupSandbox(sandbox.root);
  }

  const raw = extractJson(modelText);
  const validation = validateFindings(raw, {
    localMap: local.map,
    githubMap: github.map,
    severityThreshold: inputs.severityThreshold,
    maxFindings: inputs.maxFindings,
  });

  const findings = validation.findings.map((finding) => ({
    ...finding,
    body: renderComment(finding),
  }));
  const body = renderSummary({
    findings: validation.findings,
    omitted: validation.omitted,
    truncated: validation.truncated,
    headSha,
    baseSha,
  });

  for (const secret of [inputs.apiKey, inputs.githubToken]) {
    if (!secret) continue;
    if (
      body.includes(secret) ||
      findings.some((finding) => finding.body.includes(secret))
    ) {
      throw new Error(
        "A secret value appeared in rendered review text; refusing to post",
      );
    }
  }

  const result = await postReview({
    client,
    pullNumber,
    headSha,
    baseSha,
    body,
    findings,
    force: inputs.force,
    dryRun: inputs.dryRun,
    botLogin,
  });

  return finish(result, validation.omitted);
}

/**
 * @param {any} result
 * @param {Record<string, number>} omitted
 */
function finish(result, omitted) {
  const omittedTotal = Object.values(omitted).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (result.skipped) {
    console.log(`opencode-pr-review: skipped (${result.reason})`);
    setOutput("findings", 0);
    setOutput("review_id", "");
    setOutput("posted", "false");
    setOutput("skipped", "true");
    setOutput("omitted", omittedTotal);
    return 0;
  }

  if (result.dryRun) {
    console.log(redact(JSON.stringify(result.payload, null, 2)));
    setOutput("findings", result.findings);
    setOutput("review_id", "");
    setOutput("posted", "false");
    setOutput("skipped", "false");
    setOutput("omitted", omittedTotal);
    return 0;
  }

  if (result.fallback) {
    console.log(
      "opencode-pr-review: inline comments were rejected; posted a summary-only review",
    );
  }
  console.log(
    `opencode-pr-review: posted review ${result.reviewId} with ${result.findings} inline comments`,
  );
  setOutput("findings", result.findings);
  setOutput("review_id", result.reviewId ?? "");
  setOutput("posted", "true");
  setOutput("skipped", "false");
  setOutput("omitted", omittedTotal);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      const status = error?.status ? ` (${githubErrorText(error)})` : "";
      console.error(`opencode-pr-review: ${redactError(error)}${status}`);
      process.exitCode = 1;
    });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTrackedFiles } from "./collect-diff.mjs";

const SECRET_READ_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/*auth*.json",
  "**/*auth*.jsonc",
  "**/.npmrc",
  "**/.netrc",
  "**/.git-credentials",
  "**/id_*",
  "**/*.pem",
  "**/*.key",
  "**/.ssh/**",
  "**/.aws/**",
];

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isSensitivePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some((segment) =>
      [".git", ".opencode", "node_modules", ".ssh", ".aws"].includes(segment),
    )
  ) {
    return true;
  }
  const lower = normalized.toLowerCase();
  const base = segments.at(-1) ?? "";
  const lowerBase = base.toLowerCase();
  if (
    [
      "opencode.json",
      "opencode.jsonc",
      "agents.md",
      "claude.md",
      ".npmrc",
      ".netrc",
      ".git-credentials",
    ].includes(lowerBase)
  ) {
    return true;
  }
  if (
    lowerBase.startsWith("id_") ||
    lowerBase.endsWith(".pem") ||
    lowerBase.endsWith(".key")
  )
    return true;
  if (
    lowerBase.includes("auth") &&
    (lowerBase.endsWith(".json") || lowerBase.endsWith(".jsonc"))
  )
    return true;
  if (lowerBase.startsWith(".env") && lowerBase !== ".env.example") return true;
  if (lowerBase === ".env.example") return false;
  if (lower.includes("/.env") || lower.startsWith(".env")) return true;
  return false;
}

/**
 * Copy tracked files from a checkout into a sanitized directory.
 * @param {{source: string, destination: string}} options
 * @returns {{copied: number, skipped: number}}
 */
export function sanitizeWorkspace(options) {
  const { source, destination } = options;
  fs.mkdirSync(destination, { recursive: true });
  const files = listTrackedFiles(source);
  let copied = 0;
  let skipped = 0;

  for (const relative of files) {
    if (isSensitivePath(relative)) {
      skipped += 1;
      continue;
    }
    const from = path.join(source, relative);
    let stat;
    try {
      stat = fs.lstatSync(from);
    } catch {
      skipped += 1;
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      skipped += 1;
      continue;
    }
    const to = path.join(destination, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, stat.mode & 0o777);
    copied += 1;
  }

  return { copied, skipped };
}

/**
 * Build the inline OpenCode config. Project config is disabled separately.
 * @param {{workspace: string, model: string}} options
 * @returns {string}
 */
export function buildOpenCodeConfig(options) {
  const workspace = path.resolve(options.workspace);
  const workspaceEntries = [workspace, `${workspace}/*`];
  /** @type {Array<{action: string, resource: string, effect: string}>} */
  const permissions = [{ action: "*", resource: "*", effect: "deny" }];

  for (const resource of workspaceEntries) {
    permissions.push({
      action: "external_directory",
      resource,
      effect: "allow",
    });
  }
  for (const resource of workspaceEntries) {
    permissions.push({ action: "read", resource, effect: "allow" });
  }
  permissions.push({ action: "glob", resource: "*", effect: "allow" });
  permissions.push({ action: "grep", resource: "*", effect: "allow" });
  for (const pattern of SECRET_READ_PATTERNS) {
    permissions.push({ action: "read", resource: pattern, effect: "deny" });
  }
  permissions.push({
    action: "read",
    resource: "**/.env.example",
    effect: "allow",
  });
  for (const action of [
    "shell",
    "edit",
    "webfetch",
    "websearch",
    "subagent",
    "question",
    "execute",
    "skill",
    "browser",
  ]) {
    permissions.push({ action, resource: "*", effect: "deny" });
  }

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: options.model,
    default_agent: "pr-reviewer",
    update: "disable",
    instructions: [],
    plugins: [],
    permissions,
    agents: {
      "pr-reviewer": {
        description: "Read-only pull request reviewer",
        mode: "primary",
        prompt:
          "You are a code review agent. Follow the user message. Return only the requested JSON. Never edit files or run commands.",
      },
    },
  });
}

/**
 * Create an isolated working tree and config for one review.
 * @param {{workspace: string, model: string}} options
 */
export function createSandbox(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pr-review-"));
  const workspace = path.join(root, "workspace");
  const run = path.join(root, "run");
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  const cache = path.join(root, "cache");
  const configDir = path.join(root, "config-dir");

  for (const directory of [
    workspace,
    run,
    home,
    config,
    data,
    cache,
    configDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const copy = sanitizeWorkspace({
    source: options.workspace,
    destination: workspace,
  });
  const configContent = buildOpenCodeConfig({
    workspace,
    model: options.model,
  });

  return {
    root,
    workspace,
    run,
    home,
    config,
    data,
    cache,
    configDir,
    configContent,
    copied: copy.copied,
    skipped: copy.skipped,
  };
}

/**
 * @param {string} root
 */
export function cleanupSandbox(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

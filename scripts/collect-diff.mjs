import { execFileSync, spawn } from "node:child_process";
import { redact } from "./redact.mjs";

export class DiffError extends Error {}
export class DiffTooLargeError extends DiffError {}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function unquoteGitPath(raw) {
  let value = raw.replace(/\r$/, "");
  if (value.startsWith('"') && value.endsWith('"')) {
    const bytes = [];
    for (let index = 1; index < value.length - 1; index += 1) {
      const char = value[index];
      if (char !== "\\") {
        bytes.push(...Buffer.from(char, "utf8"));
        continue;
      }
      const next = value[index + 1];
      if (next === undefined) throw new DiffError("Invalid quoted diff path");
      const simple = {
        a: 0x07,
        b: 0x08,
        t: 0x09,
        n: 0x0a,
        v: 0x0b,
        f: 0x0c,
        r: 0x0d,
        "\\": 0x5c,
        '"': 0x22,
      };
      if (Object.hasOwn(simple, next)) {
        bytes.push(simple[next]);
        index += 1;
        continue;
      }
      if (/[0-7]/.test(next)) {
        let octal = next;
        let cursor = index + 2;
        while (octal.length < 3 && /[0-7]/.test(value[cursor] ?? "")) {
          octal += value[cursor];
          cursor += 1;
        }
        bytes.push(Number.parseInt(octal, 8));
        index = cursor - 1;
        continue;
      }
      if (next === "x") {
        const hex = value.slice(index + 2, index + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex))
          throw new DiffError("Invalid hex diff path escape");
        bytes.push(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
      bytes.push(...Buffer.from(next, "utf8"));
      index += 1;
    }
    value = Buffer.from(bytes).toString("utf8");
  } else {
    value = value.replace(/\t$/, "");
  }

  if (value === "/dev/null") return null;
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  if (!value || value.includes("\0")) return null;
  return value;
}

/**
 * @param {string} text
 * @param {string} filePath
 * @returns {Set<number>}
 */
export function parsePatch(text, _filePath) {
  const lines = new Set();
  if (!text) return lines;
  let newLine = 0;
  let inHunk = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      newLine = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      lines.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // Deleted line: no new-file advance.
    } else if (line.startsWith(" ")) {
      newLine += 1;
    } else if (line.startsWith("\\")) {
      // No newline marker.
    } else if (line.length === 0) {
      // Empty context line occasionally appears in hand-built patches.
      newLine += 1;
    } else {
      inHunk = false;
    }
  }
  return lines;
}

/**
 * @param {string} text
 * @returns {{map: Map<string, Set<number>>, binaryFiles: Set<string>}}
 */
export function parseDiff(text) {
  /** @type {Map<string, Set<number>>} */
  const map = new Map();
  const binaryFiles = new Set();
  let currentPath = null;
  let inHunk = false;
  let newLine = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
      newLine = 0;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      currentPath = unquoteGitPath(line.slice(4));
      continue;
    }
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      const match = /^Binary files .* and (.*) differ$/.exec(line);
      if (match) {
        const parsed = unquoteGitPath(match[1]);
        if (parsed) binaryFiles.add(parsed);
      } else if (currentPath) {
        binaryFiles.add(currentPath);
      }
      inHunk = false;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (!currentPath) {
        inHunk = false;
        continue;
      }
      newLine = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !currentPath) continue;
    if (line.startsWith("+")) {
      if (!map.has(currentPath)) map.set(currentPath, new Set());
      map.get(currentPath).add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // Deleted line: no new-file advance.
    } else if (line.startsWith(" ")) {
      newLine += 1;
    } else if (line.startsWith("\\")) {
      // No newline marker.
    } else {
      inHunk = false;
    }
  }

  return { map, binaryFiles };
}

/**
 * @param {Array<{filename: string, patch?: string | null}>} files
 * @returns {{map: Map<string, Set<number>>, unpatchable: Set<string>}}
 */
export function parseGitHubFiles(files) {
  const map = new Map();
  const unpatchable = new Set();
  for (const file of files) {
    if (!file || typeof file.filename !== "string") continue;
    if (typeof file.patch !== "string" || file.patch.length === 0) {
      unpatchable.add(file.filename);
      map.set(file.filename, new Set());
      continue;
    }
    map.set(file.filename, parsePatch(file.patch, file.filename));
  }
  return { map, unpatchable };
}

/**
 * Collect and parse the local diff. The caller must pass the event SHAs.
 * @param {{
 *   workspace: string,
 *   baseSha: string,
 *   headSha: string,
 *   maxBytes: number,
 *   text?: boolean,
 *   paths?: string[],
 * }} options
 * @returns {Promise<{text: string, map: Map<string, Set<number>>, binaryFiles: Set<string>}>}
 */
export async function collectDiff(options) {
  const { workspace, baseSha, headSha, maxBytes } = options;
  const args = [
    "-c",
    "core.quotepath=true",
    "-c",
    "diff.noprefix=false",
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    ...(options.text ? ["--text"] : []),
    "--find-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `${baseSha}...${headSha}`,
    ...(options.paths && options.paths.length > 0
      ? ["--", ...options.paths]
      : []),
  ];

  const text = await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    let stderr = "";
    let failed = false;

    child.stdout.on("data", (chunk) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failed = true;
        child.kill("SIGKILL");
        reject(
          new DiffTooLargeError(`Diff exceeds max-diff-bytes (${maxBytes})`),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (failed) return;
      if (code !== 0) {
        reject(
          new DiffError(`git diff failed (${code}): ${redact(stderr.trim())}`),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

  return { text, ...parseDiff(text) };
}

/**
 * @param {{workspace: string, baseSha: string, headSha: string}} options
 */
export function validateRepo(options) {
  const { workspace, baseSha, headSha } = options;
  const head = git(["rev-parse", "HEAD"], workspace).trim();
  if (head !== headSha) {
    throw new DiffError(
      `Checked-out HEAD ${head} is not the event head ${headSha}`,
    );
  }
  try {
    git(["cat-file", "-e", `${baseSha}^{commit}`], workspace);
  } catch {
    throw new DiffError(
      `Base commit ${baseSha} is not present in the checkout`,
    );
  }
  try {
    git(["merge-base", baseSha, headSha], workspace);
  } catch {
    throw new DiffError(`No merge base between ${baseSha} and ${headSha}`);
  }
}

/**
 * @param {string} workspace
 */
export function checkGitCredentials(workspace) {
  let output = "";
  try {
    output = git(
      ["config", "--get-regexp", "^http\\..*\\.extraheader$"],
      workspace,
    );
  } catch {
    return;
  }
  if (output.trim())
    throw new DiffError(
      "The checkout contains an HTTP credential in .git/config",
    );
}

/**
 * @param {string} workspace
 * @param {string} baseSha
 * @param {string} relativePath
 * @returns {string}
 */
export function readBaseFile(workspace, baseSha, relativePath) {
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath
      .split("/")
      .some((segment) => segment === ".." || segment === ".")
  ) {
    throw new DiffError("prompt-file must be a clean relative POSIX path");
  }
  try {
    return git(["show", `${baseSha}:${relativePath}`], workspace);
  } catch {
    throw new DiffError(`prompt-file not found at base: ${relativePath}`);
  }
}

/**
 * @param {string} workspace
 * @returns {string[]}
 */
export function listTrackedFiles(workspace) {
  return git(["ls-files", "-z"], workspace)
    .split("\0")
    .filter((entry) => entry.length > 0);
}

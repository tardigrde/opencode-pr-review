import { redact } from "./redact.mjs";

export class ModelOutputError extends Error {}

export const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return title
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/\.$/, "");
}

/**
 * @param {string} value
 * @param {number} limit
 * @returns {{value: string, truncated: boolean}}
 */
function truncate(value, limit) {
  if (value.length <= limit) return { value, truncated: false };
  const slice = value.slice(0, Math.max(0, limit - 1));
  const boundary = slice.lastIndexOf(" ");
  return {
    value: `${(boundary > limit * 0.6 ? slice.slice(0, boundary) : slice).trimEnd()}…`,
    truncated: true,
  };
}

/**
 * Extract the review object from model text.
 * @param {string} text
 * @returns {any}
 */
export function extractJson(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new ModelOutputError("Model returned no text");

  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray(parsed.findings)
    ) {
      return parsed;
    }
  } catch {
    // Fall through to the balanced-object scan.
  }

  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(trimmed.slice(start, index + 1));
        start = -1;
      }
    }
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Array.isArray(parsed.findings)
      ) {
        return parsed;
      }
    } catch {
      // Try the previous candidate.
    }
  }

  throw new ModelOutputError(
    `Model output did not contain a review object: ${redact(trimmed.slice(0, 500))}`,
  );
}

/**
 * @param {unknown} path
 * @returns {boolean}
 */
function validPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    return false;
  return !path
    .split("/")
    .some((segment) => segment === ".." || segment === ".");
}

/**
 * @param {any} raw
 * @param {{
 *   localMap: Map<string, Set<number>>,
 *   githubMap: Map<string, Set<number>>,
 *   severityThreshold: string,
 *   maxFindings: number,
 * }} options
 */
export function validateFindings(raw, options) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.findings)) {
    throw new ModelOutputError(
      "Model output must be an object with a findings array",
    );
  }

  const threshold = SEVERITY_RANK[options.severityThreshold];
  if (threshold === undefined)
    throw new ModelOutputError("Invalid severity threshold");

  const omitted = {
    invalidAnchor: 0,
    invalidData: 0,
    duplicate: 0,
    belowThreshold: 0,
    overLimit: 0,
  };
  let truncated = 0;
  /** @type {Array<any>} */
  const candidates = [];

  for (const entry of raw.findings) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      omitted.invalidData += 1;
      continue;
    }
    const path = entry.path;
    const line = entry.line;
    const severity = entry.severity;
    const title = entry.title;
    const problem = entry.problem;
    const fix = entry.fix;

    if (
      !validPath(path) ||
      !Number.isInteger(line) ||
      line < 1 ||
      typeof severity !== "string" ||
      !Object.hasOwn(SEVERITY_RANK, severity) ||
      typeof title !== "string" ||
      title.trim().length === 0 ||
      typeof problem !== "string" ||
      problem.trim().length === 0 ||
      typeof fix !== "string" ||
      fix.trim().length === 0
    ) {
      omitted.invalidData += 1;
      continue;
    }

    if (
      !options.localMap.get(path)?.has(line) ||
      !options.githubMap.get(path)?.has(line)
    ) {
      omitted.invalidAnchor += 1;
      continue;
    }

    let startLine;
    if (entry.start_line !== undefined && entry.start_line !== null) {
      const candidate = entry.start_line;
      if (
        Number.isInteger(candidate) &&
        candidate >= 1 &&
        candidate <= line &&
        options.localMap.get(path)?.has(candidate) &&
        options.githubMap.get(path)?.has(candidate)
      ) {
        startLine = candidate;
      }
    }

    const cappedTitle = truncate(title.trim(), 72);
    const cappedProblem = truncate(problem.trim(), 560);
    const cappedFix = truncate(fix.trim(), 280);
    if (cappedTitle.truncated || cappedProblem.truncated || cappedFix.truncated)
      truncated += 1;

    candidates.push({
      path,
      line,
      ...(startLine ? { start_line: startLine } : {}),
      severity,
      title: cappedTitle.value,
      problem: cappedProblem.value,
      fix: cappedFix.value,
      normalizedTitle: normalizeTitle(cappedTitle.value),
    });
  }

  candidates.sort((left, right) => {
    const severity =
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (severity !== 0) return severity;
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return left.line - right.line;
  });

  /** @type {Map<string, any>} */
  const deduped = new Map();
  for (const finding of candidates) {
    const key = `${finding.path}\0${finding.line}\0${finding.normalizedTitle}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, finding);
      continue;
    }
    omitted.duplicate += 1;
    const existingRank = SEVERITY_RANK[existing.severity];
    const nextRank = SEVERITY_RANK[finding.severity];
    const existingLength = existing.problem.length + existing.fix.length;
    const nextLength = finding.problem.length + finding.fix.length;
    if (
      nextRank < existingRank ||
      (nextRank === existingRank && nextLength > existingLength)
    ) {
      deduped.set(key, finding);
    }
  }

  const aboveThreshold = [];
  for (const finding of deduped.values()) {
    if (SEVERITY_RANK[finding.severity] > threshold) {
      omitted.belowThreshold += 1;
    } else {
      aboveThreshold.push(finding);
    }
  }

  const kept = aboveThreshold.slice(0, options.maxFindings);
  omitted.overLimit = Math.max(0, aboveThreshold.length - kept.length);

  return {
    findings: kept,
    omitted,
    truncated,
    totalRaw: raw.findings.length,
  };
}

export const SEVERITY_LABEL = { high: "High", medium: "Medium", low: "Low" };

/**
 * Keep model text as plain Markdown: no HTML, images, links, or mentions.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeInline(value) {
  // GitHub does not decode entities or backslash escapes inside code spans,
  // and mentions or links do not act there. Keep single-backtick spans as is.
  return String(value ?? "")
    .split(/(?<![`\\])(`[^`\n]+`)(?!`)/)
    .map((part, index) => (index % 2 === 1 ? part : sanitizePlain(part)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function sanitizePlain(value) {
  let text = value;
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<[^>]*>/g, "");
  text = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  text = text.replace(/@/g, "@\u200b");
  // Escape backticks and backslashes too, so a stray one cannot open a span.
  text = text.replace(/([\\`*_[\]()#|~!])/g, "\\$1");
  return text;
}

/**
 * @param {string} value
 * @param {number} limit
 * @returns {string}
 */
function cap(value, limit) {
  if (value.length <= limit) return value;
  const slice = value.slice(0, Math.max(0, limit - 1));
  const boundary = slice.lastIndexOf(" ");
  let cut = (
    boundary > limit * 0.6 ? slice.slice(0, boundary) : slice
  ).trimEnd();
  // Plain text has its backticks escaped, so an odd count of unescaped
  // backticks means the cut left a code span open. Drop that span.
  const ticks = [...cut.matchAll(/(?<!\\)`/g)];
  if (ticks.length % 2 === 1) cut = cut.slice(0, ticks.at(-1).index).trimEnd();
  return `${cut}…`;
}

/**
 * @param {{severity: string, title: string, problem: string, fix: string}} finding
 * @returns {string}
 */
export function renderComment(finding) {
  const body = `**${SEVERITY_LABEL[finding.severity]} — ${sanitizeInline(finding.title)}**\n\n${sanitizeInline(
    finding.problem,
  )}\n\n**Fix:** ${sanitizeInline(finding.fix)}`;
  return cap(body, 1000);
}

/**
 * @param {Record<string, number>} omitted
 * @returns {string}
 */
export function formatOmitted(omitted) {
  const labels = [
    ["invalidAnchor", "invalid anchor"],
    ["invalidData", "invalid data"],
    ["duplicate", "duplicate"],
    ["belowThreshold", "below threshold"],
    ["overLimit", "over limit"],
  ];
  const parts = labels
    .filter(([key]) => omitted[key] > 0)
    .map(([key, label]) => `${omitted[key]} ${label}`);
  if (parts.length === 0) return "";
  const total = parts.reduce((sum, part) => sum + Number.parseInt(part, 10), 0);
  return `${total} finding${total === 1 ? "" : "s"} omitted (${parts.join(", ")}).`;
}

/**
 * @param {string} headSha
 * @param {string} baseSha
 * @returns {string}
 */
export function marker(headSha, baseSha) {
  return `<!-- opencode-pr-review:v2 head=${headSha} base=${baseSha} -->`;
}

/**
 * @param {{
 *   findings: Array<{severity: string}>,
 *   omitted: Record<string, number>,
 *   truncated: number,
 *   headSha: string,
 *   baseSha: string,
 *   noAddedLines?: boolean,
 * }} options
 * @returns {string}
 */
export function renderSummary(options) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of options.findings) counts[finding.severity] += 1;
  const parts = ["high", "medium", "low"]
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`);

  const lines = ["## OpenCode review"];
  if (parts.length > 0) {
    lines.push(`${parts.join(", ")}. See inline comments.`);
  } else {
    lines.push("No actionable findings in this pass.");
  }
  if (options.noAddedLines) lines.push("No added lines to review.");

  const omitted = formatOmitted(options.omitted);
  if (omitted) lines.push(omitted);
  if (options.truncated > 0) {
    lines.push(
      `${options.truncated} finding${options.truncated === 1 ? "" : "s"} truncated.`,
    );
  }
  lines.push(marker(options.headSha, options.baseSha));
  return lines.join("\n\n");
}

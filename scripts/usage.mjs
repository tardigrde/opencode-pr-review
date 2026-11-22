/**
 * @typedef {{
 *   steps: number,
 *   input: number,
 *   output: number,
 *   reasoning: number,
 *   cacheRead: number,
 *   cacheWrite: number,
 *   cost: number,
 * }} Usage
 */

/**
 * @returns {Usage}
 */
export function emptyUsage() {
  return {
    steps: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Sum token and cost fields from every step_finish event.
 * @param {string} stdout
 * @returns {Usage}
 */
export function parseUsage(stdout) {
  const usage = emptyUsage();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "step_finish" || typeof event.part !== "object")
      continue;
    const tokens = event.part?.tokens;
    usage.steps += 1;
    usage.cost += count(event.part?.cost);
    if (!tokens || typeof tokens !== "object") continue;
    usage.input += count(tokens.input);
    usage.output += count(tokens.output);
    usage.reasoning += count(tokens.reasoning);
    usage.cacheRead += count(tokens.cache?.read);
    usage.cacheWrite += count(tokens.cache?.write);
  }
  return usage;
}

/**
 * @param {Usage} usage
 * @param {number} [durationSeconds]
 * @returns {string}
 */
export function formatUsageLine(usage, durationSeconds) {
  const parts = [
    `${usage.input} input tokens`,
    `${usage.output} output tokens`,
    `${usage.reasoning} reasoning tokens`,
    `${usage.cacheRead} cache read`,
    `${usage.cacheWrite} cache write`,
  ];
  if (usage.cost > 0) parts.push(`cost ${usage.cost}`);
  if (durationSeconds !== undefined) parts.push(`${durationSeconds}s`);
  return `opencode-pr-review: usage: ${parts.join(", ")}`;
}

/**
 * @param {{model: string, usage: Usage, durationSeconds: number}} options
 * @returns {string}
 */
export function renderUsageSummary(options) {
  const { usage } = options;
  const rows = [
    ["Model", options.model],
    ["Steps", usage.steps],
    ["Input tokens", usage.input],
    ["Output tokens", usage.output],
    ["Reasoning tokens", usage.reasoning],
    ["Cache read tokens", usage.cacheRead],
    ["Cache write tokens", usage.cacheWrite],
    ["Cost", usage.cost],
    ["Duration (seconds)", options.durationSeconds],
  ];
  return [
    "### OpenCode review usage",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
    "",
  ].join("\n");
}

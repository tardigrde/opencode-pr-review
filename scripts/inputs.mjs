export class InputError extends Error {}

const DEFAULTS = {
  model: "opencode-go/deepseek-v4.1-flash",
  maxFindings: 20,
  severityThreshold: "medium",
  maxDiffBytes: 300000,
  timeoutSeconds: 1500,
  opencodeVersion: "2.3.2",
};

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string | undefined}
 */
function optional(env, name) {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * @param {string} name
 * @param {string | undefined} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBoolean(name, value, fallback) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InputError(`${name} must be "true" or "false"`);
}

/**
 * @param {string} name
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseInteger(name, value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new InputError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new InputError(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * @param {string} value
 * @returns {string}
 */
function validatePromptFile(value) {
  if (value.startsWith("/"))
    throw new InputError("prompt-file must be relative");
  if (value.includes("\\") || value.includes("\0")) {
    throw new InputError("prompt-file must be a POSIX path");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === ".." || segment === "." || segment === "",
    )
  ) {
    throw new InputError("prompt-file must not contain . or .. segments");
  }
  return value;
}

/**
 * Read and validate action inputs from environment variables.
 * @param {Record<string, string | undefined>} [env]
 */
export function readInputs(env = process.env) {
  const model = optional(env, "INPUT_MODEL") ?? DEFAULTS.model;
  if (!/^[^/\s]+\/[^\s]+$/.test(model)) {
    throw new InputError("model must use provider/model format");
  }

  const apiKey = optional(env, "INPUT_OPENCODE_API_KEY");
  if (!apiKey) throw new InputError("opencode-api-key is required");

  const prompt = optional(env, "INPUT_PROMPT") ?? "";
  const promptFileValue = optional(env, "INPUT_PROMPT_FILE");
  if (prompt && promptFileValue) {
    throw new InputError("Use prompt or prompt-file, not both");
  }

  const severityThreshold =
    optional(env, "INPUT_SEVERITY_THRESHOLD") ?? DEFAULTS.severityThreshold;
  if (!["high", "medium", "low"].includes(severityThreshold)) {
    throw new InputError("severity-threshold must be high, medium, or low");
  }

  const opencodeVersion =
    optional(env, "INPUT_OPENCODE_VERSION") ?? DEFAULTS.opencodeVersion;
  if (!/^\d+\.\d+\.\d+$/.test(opencodeVersion)) {
    throw new InputError("opencode-version must be an exact X.Y.Z version");
  }

  const dryRun = parseBoolean("dry-run", optional(env, "INPUT_DRY_RUN"), false);
  const force = parseBoolean("force", optional(env, "INPUT_FORCE"), false);
  const githubToken = optional(env, "INPUT_GITHUB_TOKEN") ?? "";
  if (!dryRun && !githubToken)
    throw new InputError("github-token is required unless dry-run is true");

  return {
    model,
    apiKey,
    githubToken,
    prompt,
    promptFile: promptFileValue ? validatePromptFile(promptFileValue) : "",
    maxFindings: parseInteger(
      "max-findings",
      optional(env, "INPUT_MAX_FINDINGS"),
      DEFAULTS.maxFindings,
      1,
      100,
    ),
    severityThreshold,
    maxDiffBytes: parseInteger(
      "max-diff-bytes",
      optional(env, "INPUT_MAX_DIFF_BYTES"),
      DEFAULTS.maxDiffBytes,
      1,
      5000000,
    ),
    timeoutSeconds: parseInteger(
      "timeout-seconds",
      optional(env, "INPUT_TIMEOUT_SECONDS"),
      DEFAULTS.timeoutSeconds,
      60,
      1800,
    ),
    dryRun,
    force,
    opencodeVersion,
  };
}

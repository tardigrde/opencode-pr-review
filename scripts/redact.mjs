const secrets = new Set();

/**
 * Register a value that must never appear in logs or posted text.
 * @param {string | undefined} value
 */
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 4) secrets.add(value);
}

/**
 * Replace every registered secret in a string.
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text;
}

/**
 * Return a short, redacted error message.
 * @param {unknown} error
 * @returns {string}
 */
export function redactError(error) {
  if (error instanceof Error) return redact(error.message);
  return redact(error);
}

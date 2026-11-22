import { spawn } from "node:child_process";
import { redact } from "./redact.mjs";
import { parseUsage } from "./usage.mjs";

export class OpenCodeError extends Error {}

/**
 * @param {string} stdout
 * @returns {string}
 */
export function parseOpencodeEvents(stdout) {
  const texts = [];
  let lastReason;
  let sawError;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "error") {
      const detail =
        (typeof event.part?.error === "string" && event.part.error) ||
        (typeof event.error?.message === "string" && event.error.message) ||
        (typeof event.message === "string" && event.message) ||
        "unknown error";
      sawError = redact(detail);
      continue;
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      texts.push(event.part.text);
    }
    if (
      event.type === "step_finish" &&
      typeof event.part?.reason === "string"
    ) {
      lastReason = event.part.reason;
    }
  }

  if (sawError) throw new OpenCodeError(`OpenCode error: ${sawError}`);
  if (lastReason === "length" || lastReason === "content-filter") {
    throw new OpenCodeError(`OpenCode stopped early: ${lastReason}`);
  }
  if (texts.length === 0) throw new OpenCodeError("OpenCode returned no text");
  return texts.join("");
}

/**
 * @param {{
 *   apiKey: string,
 *   configContent: string,
 *   home: string,
 *   config: string,
 *   data: string,
 *   cache: string,
 *   configDir: string,
 * }} options
 * @returns {Record<string, string>}
 */
export function buildChildEnv(options) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: options.home,
    LANG: process.env.LANG ?? "C.UTF-8",
    XDG_CONFIG_HOME: options.config,
    XDG_DATA_HOME: options.data,
    XDG_CACHE_HOME: options.cache,
    OPENCODE_API_KEY: options.apiKey,
    OPENCODE_CONFIG_CONTENT: options.configContent,
    OPENCODE_CONFIG_DIR: options.configDir,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
}

/**
 * @param {{
 *   bin: string,
 *   model: string,
 *   prompt: string,
 *   configContent: string,
 *   apiKey: string,
 *   runDir: string,
 *   home: string,
 *   config: string,
 *   data: string,
 *   cache: string,
 *   configDir: string,
 *   timeoutSeconds: number,
 * }} options
 * @returns {Promise<{text: string, usage: import("./usage.mjs").Usage}>}
 */
export function runOpencode(options) {
  const env = buildChildEnv(options);

  return new Promise((resolve, reject) => {
    const child = spawn(
      options.bin,
      [
        "run",
        "--standalone",
        "--archived",
        "--agent",
        "pr-reviewer",
        "--model",
        options.model,
        "--format",
        "json",
      ],
      {
        cwd: options.runDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 20 * 1024 * 1024) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString();
    });
    child.on("error", (error) =>
      finish(reject, new OpenCodeError(redact(error.message))),
    );
    child.on("close", (code) => {
      if (timedOut) {
        finish(
          reject,
          new OpenCodeError(
            `OpenCode timed out after ${options.timeoutSeconds} seconds`,
          ),
        );
        return;
      }
      if (code !== 0) {
        finish(
          reject,
          new OpenCodeError(
            `OpenCode exited with code ${code}: ${redact(stderr.trim().slice(-500))}`,
          ),
        );
        return;
      }
      try {
        finish(resolve, {
          text: parseOpencodeEvents(stdout),
          usage: parseUsage(stdout),
        });
      } catch (error) {
        finish(reject, error);
      }
    });

    child.stdin.end(options.prompt);
  });
}

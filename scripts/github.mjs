import { redact } from "./redact.mjs";

export class GitHubError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, message, details) {
    super(redact(message));
    this.name = "GitHubError";
    this.status = status;
    this.details = details;
  }
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class GitHubClient {
  /**
   * @param {{
   *   token: string,
   *   repository: string,
   *   apiUrl?: string,
   *   fetchImpl?: typeof fetch,
   * }} options
   */
  constructor(options) {
    this.token = options.token;
    this.repository = options.repository;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * @param {string} path
   * @param {RequestInit & {retry?: number}} [options]
   * @returns {Promise<{data: any, headers: Headers}>}
   */
  async request(path, options = {}) {
    const { retry = 3, ...init } = options;
    let lastError;
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(`${this.apiUrl}${path}`, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(30000),
          headers: {
            Accept: "application/vnd.github+json",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            "User-Agent": "opencode-pr-review",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(init.headers ?? {}),
          },
        });
      } catch (error) {
        lastError = error;
        if (attempt < retry) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        break;
      }

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (response.ok) return { data, headers: response.headers };

      const message =
        typeof data === "object" && data && typeof data.message === "string"
          ? data.message
          : `GitHub API ${response.status}`;
      const details =
        typeof data === "object" && data && Array.isArray(data.errors)
          ? data.errors
          : undefined;

      const secondary =
        response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          /secondary rate limit/i.test(message));
      const retryable =
        response.status >= 500 || response.status === 429 || secondary;
      if (!retryable || attempt >= retry) {
        throw new GitHubError(response.status, message, details);
      }

      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    }

    throw new GitHubError(0, "GitHub request failed", lastError);
  }

  /**
   * @param {number} pullNumber
   */
  async getPull(pullNumber) {
    const { data } = await this.request(
      `/repos/${this.repository}/pulls/${pullNumber}`,
    );
    return data;
  }

  /**
   * @param {number} pullNumber
   * @returns {Promise<Array<any>>}
   */
  async getPullFiles(pullNumber) {
    const files = [];
    for (let page = 1; page <= 20; page += 1) {
      const { data } = await this.request(
        `/repos/${this.repository}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      );
      if (!Array.isArray(data))
        throw new GitHubError(0, "Invalid pull files response");
      files.push(...data);
      if (data.length < 100) break;
    }
    return files;
  }

  /**
   * @param {number} pullNumber
   * @returns {Promise<Array<any>>}
   */
  async getReviews(pullNumber) {
    const reviews = [];
    for (let page = 1; page <= 20; page += 1) {
      const { data } = await this.request(
        `/repos/${this.repository}/pulls/${pullNumber}/reviews?per_page=100&page=${page}`,
      );
      if (!Array.isArray(data))
        throw new GitHubError(0, "Invalid reviews response");
      reviews.push(...data);
      if (data.length < 100) break;
    }
    return reviews;
  }

  /**
   * @returns {Promise<string>}
   */
  async getBotLogin() {
    try {
      const { data } = await this.request("/user");
      if (data && typeof data.login === "string") return data.login;
    } catch {
      // Installation tokens may not expose /user.
    }
    return "github-actions[bot]";
  }

  /**
   * @param {number} pullNumber
   * @param {object} payload
   */
  async createReview(pullNumber, payload) {
    const { data } = await this.request(
      `/repos/${this.repository}/pulls/${pullNumber}/reviews`,
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        // A retry after a lost response could post a duplicate review.
        retry: 0,
      },
    );
    return data;
  }

  /**
   * @param {number} pullNumber
   * @param {number} reviewId
   * @param {string} body
   */
  async updateReview(pullNumber, reviewId, body) {
    const { data } = await this.request(
      `/repos/${this.repository}/pulls/${pullNumber}/reviews/${reviewId}`,
      {
        method: "PUT",
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
      },
    );
    return data;
  }
}

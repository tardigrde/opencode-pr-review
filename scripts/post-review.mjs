import { marker } from "./render.mjs";

/**
 * @param {Array<any>} reviews
 * @param {string} botLogin
 * @param {string} headSha
 * @param {string} baseSha
 * @returns {any | undefined}
 */
export function findExistingReview(reviews, botLogin, headSha, baseSha) {
  const expected = marker(headSha, baseSha);
  const candidates = reviews
    .filter(
      (review) =>
        review &&
        review.state !== "PENDING" &&
        review.user?.login === botLogin &&
        typeof review.body === "string",
    )
    .sort((left, right) => {
      const leftTime = new Date(
        left.submitted_at ?? left.created_at ?? 0,
      ).getTime();
      const rightTime = new Date(
        right.submitted_at ?? right.created_at ?? 0,
      ).getTime();
      return leftTime - rightTime || (left.id ?? 0) - (right.id ?? 0);
    });

  const latest = candidates.at(-1);
  if (!latest) return undefined;
  const lastLine = latest.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return lastLine === expected ? latest : undefined;
}

/**
 * @param {Array<any>} findings
 * @returns {Array<any>}
 */
export function buildComments(findings) {
  return findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: "RIGHT",
    ...(finding.start_line
      ? { start_line: finding.start_line, start_side: "RIGHT" }
      : {}),
    body: finding.body,
  }));
}

/**
 * @param {{
 *   client: any,
 *   pullNumber: number,
 *   headSha: string,
 *   baseSha: string,
 *   body: string,
 *   findings: Array<{path: string, line: number, start_line?: number, body: string}>,
 *   force: boolean,
 *   dryRun: boolean,
 *   botLogin: string,
 * }} options
 */
export async function postReview(options) {
  const reviews = await options.client.getReviews(options.pullNumber);
  const existing = findExistingReview(
    reviews,
    options.botLogin,
    options.headSha,
    options.baseSha,
  );
  if (existing && !options.force) {
    return {
      skipped: true,
      reason: "same head",
      reviewId: undefined,
      findings: 0,
    };
  }

  const pull = await options.client.getPull(options.pullNumber);
  if (pull?.head?.sha !== options.headSha) {
    return {
      skipped: true,
      reason: `head moved from ${options.headSha} to ${pull?.head?.sha ?? "unknown"}`,
      reviewId: undefined,
      findings: 0,
    };
  }

  const comments = buildComments(options.findings);
  const payload = {
    commit_id: options.headSha,
    event: "COMMENT",
    body: options.body,
    comments,
  };

  if (options.dryRun) {
    return { dryRun: true, skipped: false, findings: comments.length, payload };
  }

  let review;
  try {
    review = await options.client.createReview(options.pullNumber, payload);
  } catch (error) {
    if (error?.status !== 422) throw error;
    const note = `${comments.length} inline comments omitted by GitHub validation.`;
    const markerLine = marker(options.headSha, options.baseSha);
    const fallbackBody = options.body.includes(markerLine)
      ? options.body.replace(markerLine, `${note}\n\n${markerLine}`)
      : `${options.body}\n\n${note}`;
    review = await options.client.createReview(options.pullNumber, {
      ...payload,
      body: fallbackBody,
      comments: [],
    });
    if (existing) {
      try {
        await options.client.updateReview(
          options.pullNumber,
          existing.id,
          "Superseded by a later review at this head.",
        );
      } catch {
        // The new review is posted; an old-body update is best effort.
      }
    }
    return {
      skipped: false,
      dryRun: false,
      reviewId: review.id,
      findings: 0,
      fallback: true,
    };
  }

  if (existing) {
    try {
      await options.client.updateReview(
        options.pullNumber,
        existing.id,
        "Superseded by a later review at this head.",
      );
    } catch {
      // Best effort.
    }
  }

  return {
    skipped: false,
    dryRun: false,
    reviewId: review.id,
    findings: comments.length,
    fallback: false,
  };
}

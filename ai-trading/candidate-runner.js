"use strict";

function isFatalCandidateError(error) {
  if (error?.orderMayBeOpen === false) return false;
  if (error?.orderMayBeOpen === true) return true;
  const message = String(error?.message || error || "");
  return /BINANCE_(?:429|418)_|RATE_LIMIT|TimeoutError|AbortError|fetch failed|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|Mongo(?:Server|Network|Topology)|MONGO/i.test(message);
}

async function attemptRankedCandidates(candidates, attempt, options = {}) {
  if (!Array.isArray(candidates) || typeof attempt !== "function")
    throw new TypeError("INVALID_CANDIDATE_ATTEMPT_INPUT");
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0;
  const isFatal = options.isFatalError || isFatalCandidateError;
  const ordered = [...candidates].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  let attempted = 0;
  for (const candidate of ordered) {
    const score = Number(candidate.score) || 0;
    if (score < minScore) continue;
    attempted++;
    try {
      const result = await attempt(candidate);
      if (result?.opened === true) return { opened: true, candidate, result, attempted, fatal: false };
    } catch (error) {
      if (typeof options.onCandidateError === "function") options.onCandidateError(candidate, error);
      if (isFatal(error)) return { opened: false, candidate, error, attempted, fatal: true };
    }
  }
  return { opened: false, candidate: null, result: null, attempted, fatal: false };
}

module.exports = { attemptRankedCandidates, isFatalCandidateError };

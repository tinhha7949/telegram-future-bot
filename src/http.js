"use strict";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function isRetryable(error) {
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(error.status))) return true;
  return error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError;
}

async function requestJson(url, timeoutMs = 12000, headers = {}, options = {}) {
  const retries = Math.max(0, Number(options.retries ?? 2));
  const retryBaseMs = Math.max(250, Number(options.retryBaseMs ?? 1500));
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", ...headers }
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (error && error.name === "TypeError" && error.message === "fetch failed") {
        const hostname = new URL(url).hostname;
        const cause = error.cause;
        const detail = cause && (cause.code || cause.message);
        lastError = new Error(detail
          ? `Network fetch failed (${hostname}): ${detail}`
          : `Network fetch failed (${hostname}); underlying cause unavailable`);
        lastError.name = error.name;
        if (cause) lastError.cause = cause;
      }
      if (timedOut) {
        lastError = new Error(`Request timeout after ${timeoutMs}ms (${new URL(url).hostname})`);
        lastError.name = "TimeoutError";
      } else if (error.name === "AbortError") {
        lastError = new Error(`Request aborted (${new URL(url).hostname})`);
        lastError.name = "AbortError";
      }

      if (attempt >= retries || !isRetryable(lastError) || (Number(lastError.status) === 429 && options.retryOnRateLimit === false)) throw lastError;

      const serverDelay = Math.min(15 * 60 * 1000, Number(lastError.retryAfterMs || 0));
      const backoff = Math.min(15000, retryBaseMs * (2 ** attempt));
      await sleep(serverDelay || backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Request failed");
}

module.exports = { requestJson, sleep, retryAfterMs, isRetryable };

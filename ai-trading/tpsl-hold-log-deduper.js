"use strict";

const DEFAULT_REMINDER_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TRACKED_SYMBOLS = 500;
const lastLoggedBySymbol = new Map();

/**
 * Returns true for a new HOLD state/reason or a periodic reminder.
 * The changing score is intentionally excluded from the signature so normal
 * scanner score jitter does not flood logs.
 */
function shouldLogTpslHold(symbol, side, reason, now = Date.now(), intervalMs = DEFAULT_REMINDER_INTERVAL_MS) {
  const key = String(symbol || "UNKNOWN").toUpperCase();
  const signature = `${String(side || "WAIT").toUpperCase()}|${String(reason || "unknown")}`;
  const previous = lastLoggedBySymbol.get(key);
  const changed = !previous || previous.signature !== signature;
  const reminderDue = previous && Number.isFinite(now) && now - previous.loggedAt >= intervalMs;
  if (!changed && !reminderDue) return false;

  lastLoggedBySymbol.delete(key);
  lastLoggedBySymbol.set(key, { signature, loggedAt: now });
  while (lastLoggedBySymbol.size > MAX_TRACKED_SYMBOLS) {
    lastLoggedBySymbol.delete(lastLoggedBySymbol.keys().next().value);
  }
  return true;
}

function resetTpslHoldLogState() {
  lastLoggedBySymbol.clear();
}

module.exports = { shouldLogTpslHold, resetTpslHoldLogState, DEFAULT_REMINDER_INTERVAL_MS };

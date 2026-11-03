"use strict";

function cooldownUntilForTrade(closedAt, cooldownMinutes) {
  const closedAtMs = new Date(closedAt).getTime();
  const minutes = Number(cooldownMinutes);
  if (!Number.isFinite(closedAtMs) || !Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(closedAtMs + minutes * 60_000);
}

function isCoolingDown(cooldown, now = Date.now()) {
  if (!cooldown) return false;
  const until = new Date(cooldown.until ?? cooldown).getTime();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(until) && Number.isFinite(nowMs) && until > nowMs;
}

module.exports = { cooldownUntilForTrade, isCoolingDown };

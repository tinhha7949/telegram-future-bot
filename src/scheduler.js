"use strict";

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function startScheduler(config, storage, handlers) {
  const initial = Date.now();
  let lastNewsBucket = Math.floor(initial / (config.newsPollMinutes * 60000));
  let lastMarketBucket = Math.floor(initial / (config.marketPollMinutes * 60000));
  let lastDailyKey = "";
  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      const p = localParts(now, config.timezone);
      const day = `${p.year}-${p.month}-${p.day}`;
      const minute = Number(p.hour) * 60 + Number(p.minute);
      const [targetHour, targetMinute] = config.dailyReportTime.split(":").map(Number);
      const target = targetHour * 60 + targetMinute;
      const newsBucket = Math.floor(now.getTime() / (config.newsPollMinutes * 60000));
      const marketBucket = Math.floor(now.getTime() / (config.marketPollMinutes * 60000));

      if (minute >= target && lastDailyKey !== day) {
        if (await storage.wasDailySent(day)) {
          lastDailyKey = day;
        } else {
          await handlers.onDailyReport();
          lastDailyKey = day;
          await storage.markDailySent(day);
        }
      }
      if (newsBucket !== lastNewsBucket) {
        lastNewsBucket = newsBucket;
        await handlers.onNewsPoll();
      }
      if (marketBucket !== lastMarketBucket) {
        lastMarketBucket = marketBucket;
        await handlers.onMarketPoll();
      }
    } catch (error) {
      handlers.onError(error);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(tick, 30000);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}

module.exports = { startScheduler, localParts };

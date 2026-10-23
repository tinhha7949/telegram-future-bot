"use strict";
const { CONFIG } = require("./config");
const BAR_MS = CONFIG.BAR_HOURS * 60 * 60 * 1000;
class FourHourHistory {
  constructor(fetchRows, now = Date.now) {
    this.fetchRows = fetchRows;
    this.now = now;
    this.cache = new Map();
    this.pending = new Map();
  }
  async get(symbol, limit = CONFIG.HISTORY_MAX_INCREMENTAL_CANDLES) {
    const bucket = Math.floor(this.now() / BAR_MS),
      old = this.cache.get(symbol);
    if (
      old &&
      old.bucket === bucket &&
      old.limit >= limit &&
      (old.complete || this.now() - old.fetchedAt < CONFIG.HISTORY_INCOMPLETE_CACHE_MS)
    )
      return structuredClone(old.rows.slice(-limit));
    if (this.pending.has(symbol)) {
      await this.pending.get(symbol);
      return this.get(symbol, limit);
    }
    const task = this.refresh(symbol, limit, bucket);
    this.pending.set(symbol, task);
    try {
      await task;
    } finally {
      this.pending.delete(symbol);
    }
    if (this.cache.get(symbol).bucket !== Math.floor(this.now() / BAR_MS))
      return this.get(symbol, limit);
    return structuredClone(this.cache.get(symbol).rows.slice(-limit));
  }
  async refresh(symbol, limit, bucket) {
    const old = this.cache.get(symbol),
      end = (bucket + 1) * BAR_MS - 1;
    const incremental =
      old &&
      old.limit >= limit &&
      old.rows.length &&
      end - Number(old.rows.at(-1)[0]) < limit * BAR_MS;
    let rows = incremental ? old.rows : [];
    if (incremental) {
      const updates = await this.fetchRows(
        symbol,
        Math.min(CONFIG.HISTORY_MAX_INCREMENTAL_CANDLES, Math.ceil((end - Number(rows.at(-1)[0]) + 1) / BAR_MS)),
        { startTime: Number(rows.at(-1)[0]), endTime: end },
      );
      rows = rows.concat(updates);
    } else {
      let cursor = end;
      while (rows.length < limit) {
        const size = Math.min(CONFIG.HISTORY_PAGE_CANDLES, limit - rows.length),
          page = await this.fetchRows(symbol, size, { endTime: cursor });
        if (!page.length) break;
        const next = Number(page[0][0]) - 1;
        if (!(next < cursor)) throw new Error("CANDLE_PAGINATION_STALLED");
        rows = page.concat(rows);
        cursor = next;
        if (page.length < size) break;
      }
    }
    rows = [...new Map(rows.map((r) => [Number(r[0]), r])).values()]
      .filter((r) => Number(r[0]) <= end)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(-limit);
    const complete = rows.some((r) => Number(r[6]) === bucket * BAR_MS - 1);
    this.cache.set(symbol, {
      bucket,
      limit,
      rows,
      complete,
      fetchedAt: this.now(),
    });
  }
}
module.exports = { FourHourHistory, BAR_MS };

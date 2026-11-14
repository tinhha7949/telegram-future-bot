"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchYahoo, safeDate, sourceWeight } = require("../src/collectors");

test("fetchYahoo uses completed hourly candles and reports their observation time", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const hourMs = 3600000;
  const currentHour = Math.floor(Date.now() / hourMs) * hourMs;
  const lastOpen = currentHour - hourMs;
  const timestamps = [];
  const close = [];
  for (let i = 0; i < 800; i++) {
    timestamps.push(Math.floor((lastOpen - (799 - i) * hourMs) / 1000));
    close.push(1000 + i);
  }
  let requestedUrl;
  global.fetch = async url => {
    requestedUrl = new URL(String(url));
    return {
      ok:true,
      json:async () => ({
        chart:{ result:[{
          meta:{ currency:"USD" },
          timestamp:timestamps,
          indicators:{ quote:[{ close }] }
        }], error:null }
      })
    };
  };

  const result = await fetchYahoo("GC=F", { requestTimeoutMs:1000, httpRetryBaseMs:250 });
  assert.equal(requestedUrl.searchParams.get("interval"), "1h");
  assert.equal(result.price, close.at(-1));
  assert.equal(result.marketTime.getTime(), currentHour);
  assert.ok(result.momentum["24h"] > 0);
  assert.ok(result.momentum["3d"] > result.momentum["24h"]);
  assert.ok(result.momentum["30d"] > result.momentum["7d"]);
});

test("safeDate handles GDELT timestamps and invalid dates", () => {
  assert.equal(safeDate("20261114T120000Z").toISOString(), "2026-11-14T12:00:00.000Z");
  assert.ok(Number.isFinite(safeDate("not-a-date").getTime()));
});

test("sourceWeight recognizes major financial and official sources", () => {
  assert.equal(sourceWeight("reuters.com"), 1.15);
  assert.equal(sourceWeight("eia.gov"), 1.25);
  assert.equal(sourceWeight("unknown.example"), 0.8);
});

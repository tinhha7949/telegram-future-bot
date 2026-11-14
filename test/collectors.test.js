"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchYahoo, safeDate, sourceWeight, parseRss, headlineRelevant, collectNews } = require("../src/collectors");
const { forecastDueAt } = require("../src/storage");

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

test("forecast due time is measured from the reference market candle", () => {
  const referenceAt = new Date("2026-11-14T10:00:00.000Z");
  assert.equal(forecastDueAt(referenceAt, 24).toISOString(), "2026-11-15T10:00:00.000Z");
  assert.equal(forecastDueAt(referenceAt, 72).toISOString(), "2026-11-17T10:00:00.000Z");
});

test("RSS parser reads RSS and Atom entries including Google News publisher attribution", () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[Gold rises as US yields fall]]></title><link>https://news.google.com/rss/articles/example</link><pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate><source url="https://www.cnbc.com">CNBC</source></item></channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Gold rises as US yields fall");
  assert.equal(items[0].source, "CNBC");
  assert.equal(items[0].sourceUrl, "https://www.cnbc.com");
  assert.equal(items[0].publishedAt.toISOString(), "2026-11-14T10:00:00.000Z");
  const atom = `<feed><entry><title>Fed signals rates outlook</title><link href="https://example.com/story" rel="alternate"/><updated>2026-11-14T10:00:00Z</updated></entry></feed>`;
  assert.equal(parseRss(atom)[0].url, "https://example.com/story");
});

test("generic RSS feeds are filtered to relevant asset classes", () => {
  assert.equal(headlineRelevant("EIA reports crude oil inventory draw", "energy"), true);
  assert.equal(headlineRelevant("EIA reports crude oil inventory draw", "stocks"), false);
});

test("news collection continues with healthy feeds when an earlier provider fails", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const xml = '<rss><channel><item><title>Gold demand rises as central banks buy bullion</title><link>https://news.example/gold</link><pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>';
  const requested = [];
  global.fetch = async url => {
    const host = new URL(String(url)).hostname;
    if (host === "translate.googleapis.com") {
      return { ok:true, json:async () => [[["Nhu cầu vàng tăng khi các ngân hàng trung ương mua vàng", "Gold demand rises as central banks buy bullion"]]] };
    }
    requested.push(host);
    if (host === "bad-provider.example") return { ok:false, status:503, headers:{ get:() => null } };
    return { ok:true, text:async () => xml };
  };
  let savedItems = [];
  const config = {
    requestTimeoutMs:1000, newsRequestTimeoutMs:1000, newsHttpRetries:0,
    newsSourceConcurrency:1, maxNewsPerCategory:10, importantNewsScore:3,
    httpRetryBaseMs:250, assets:[{ id:"gold", name:"VÀNG" }],
    newsSources:[
      { id:"test-bad-provider", url:"https://bad-provider.example/feed", assets:["gold"] },
      { id:"test-good-provider", url:"https://good-provider.example/feed", assets:["gold"] }
    ]
  };
  const storage = { saveNews:async items => { savedItems = items; return { inserted:items.length, importantNews:[] }; } };
  const result = await collectNews(config, storage);
  assert.deepEqual(requested, ["bad-provider.example", "good-provider.example"]);
  assert.equal(result.found, 1);
  assert.equal(savedItems[0].title, "Nhu cầu vàng tăng khi các ngân hàng trung ương mua vàng");
  assert.equal(savedItems[0].originalTitle, "Gold demand rises as central banks buy bullion");
});

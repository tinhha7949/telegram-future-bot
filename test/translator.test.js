"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { translateToVietnamese } = require("../src/translator");

test("headline translation requests Vietnamese and returns translated text", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let requestedUrl;
  global.fetch = async url => {
    requestedUrl = new URL(String(url));
    return {
      ok:true,
      json:async () => [[["Lạm phát Mỹ cao hơn dự kiến trong tháng 10", "US inflation higher than expected in October"]]]
    };
  };
  const result = await translateToVietnamese("US inflation higher than expected in October", { translationTimeoutMs:1000 });
  assert.equal(requestedUrl.searchParams.get("tl"), "vi");
  assert.equal(result, "Lạm phát Mỹ cao hơn dự kiến trong tháng 10");
});

test("Vietnamese headlines do not require an external translation request", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("Should not be called"); };
  const title = "Giá vàng tăng khi đồng USD suy yếu";
  assert.equal(await translateToVietnamese(title), title);
  assert.equal(calls, 0);
});

test("headline translation falls back to the second free provider", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const hosts = [];
  global.fetch = async url => {
    const parsed = new URL(String(url));
    hosts.push(parsed.hostname);
    if (parsed.hostname === "translate.googleapis.com") return { ok:false, status:503, headers:{ get:() => null } };
    return {
      ok:true,
      json:async () => ({ responseData:{ translatedText:"Giá dầu tăng do nguồn cung bị gián đoạn" } })
    };
  };
  const result = await translateToVietnamese("Oil prices rise as supply is disrupted", { translationTimeoutMs:1000 });
  assert.equal(result, "Giá dầu tăng do nguồn cung bị gián đoạn");
  assert.deepEqual(hosts, ["translate.googleapis.com", "api.mymemory.translated.net"]);
});

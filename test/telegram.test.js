"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Telegram } = require("../src/telegram");

test("Telegram retries rate limits and sends the message after the cooldown", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok:false,
        status:429,
        text:async () => JSON.stringify({
          ok:false,
          description:"Too Many Requests",
          parameters:{ retry_after:0 }
        })
      };
    }
    return { ok:true, status:200, text:async () => JSON.stringify({ ok:true }) };
  };

  const telegram = new Telegram({ requestTimeoutMs:1000 });
  telegram.token = "test-token";
  telegram.chatId = "test-chat";
  await telegram.send("test message");
  assert.equal(calls, 2);
});

test("Telegram does not retry permanent client errors", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      ok:false,
      status:400,
      text:async () => JSON.stringify({ ok:false, description:"Bad Request" })
    };
  };

  const telegram = new Telegram({ requestTimeoutMs:1000 });
  telegram.token = "test-token";
  telegram.chatId = "test-chat";
  await assert.rejects(telegram.send("test message"), /Bad Request/);
  assert.equal(calls, 1);
});

test("Telegram retries server errors even when the proxy returns non-JSON", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok:false, status:502, text:async () => "<html>bad gateway</html>" };
    return { ok:true, status:200, text:async () => JSON.stringify({ ok:true }) };
  };

  const telegram = new Telegram({ requestTimeoutMs:1000 });
  telegram.token = "test-token";
  telegram.chatId = "test-chat";
  await telegram.send("test message");
  assert.equal(calls, 2);
});

test("Telegram splits long Unicode messages without losing or breaking characters", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const sent = [];
  global.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body).text);
    return { ok:true, status:200, text:async () => JSON.stringify({ ok:true }) };
  };

  const telegram = new Telegram({ requestTimeoutMs:1000 });
  telegram.token = "test-token";
  telegram.chatId = "test-chat";
  const message = "A".repeat(3899) + "🟡" + "B".repeat(200);
  await telegram.send(message);

  assert.equal(sent.length, 2);
  assert.equal(sent[0].length, 3901);
  assert.equal(sent.join(""), message);
  assert.ok(sent.every(chunk => !chunk.includes("\\uFFFD")));
});

test("daily Telegram report translates forecast directions and source labels", async () => {
  const telegram = new Telegram({ requestTimeoutMs:1000, timezone:"Asia/Ho_Chi_Minh", symbolLabels:{} });
  const report = await telegram.buildDailyReport([{
    assetId:"gold", assetName:"VÀNG (XAUUSD)", direction:"NEUTRAL", confidence:65,
    summary:"Chưa có lợi thế tăng/giảm đủ rõ; nên chờ thêm xác nhận.",
    forecasts:[{
      horizon:"24h", label:"24 GIỜ", direction:"BULLISH", confidence:65, score:0.9,
      evidenceCount:3, rationale:"Tín hiệu tổng hợp nghiêng tăng.", drivers:["Nhu cầu vàng tăng"],
      risks:["Lợi suất trái phiếu tăng"]
    }],
    risks:[], caveat:"Dữ liệu xác nhận còn ít."
  }], {
    getLatestMarkets:async () => [],
    getRecentNews:async () => [{
      title:"Lạm phát Mỹ cao hơn dự kiến", source:"The Guardian", importance:8,
      impactScore:-0.3, url:"https://example.test/news"
    }]
  });
  assert.match(report, /TRUNG LẬP/);
  assert.match(report, /XU HƯỚNG TĂNG/);
  assert.match(report, /Lạm phát Mỹ cao hơn dự kiến/);
  assert.doesNotMatch(report, /NEUTRAL|BULLISH|inflation_hot|The Guardian|Nguồn:|http/);
});

test("queued English news alerts are converted to Vietnamese before sending", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async url => {
    const requested = new URL(String(url));
    assert.equal(requested.hostname, "translate.googleapis.com");
    return {
      ok:true,
      json:async () => [[["Lạm phát Mỹ cao hơn dự kiến trong tháng 10", "US inflation higher than expected in October"]]]
    };
  };
  const telegram = new Telegram({ requestTimeoutMs:1000, translationTimeoutMs:1000 });
  const localized = await telegram.localizeMessage([
    "🚨 TIN TỨC QUAN TRỌNG | VÀNG (XAUUSD)",
    "US inflation higher than expected in October",
    "Sự kiện: inflation_hot",
    "Tác động theo mô hình: TIÊU CỰC (-0.3)",
    "Dự báo 24h sau cập nhật: NEUTRAL | điểm 65/82",
    "Mức độ: 8/10",
    "Nguồn: The Guardian",
    "https://example.test/news"
  ].join("\n"));
  assert.match(localized, /Lạm phát Mỹ cao hơn dự kiến/);
  assert.match(localized, /Lạm phát cao hơn dự kiến/);
  assert.match(localized, /TRUNG LẬP/);
  assert.match(localized, /Mức độ quan trọng: 8\/10/);
  assert.doesNotMatch(localized, /inflation_hot|NEUTRAL|US inflation/);
});

test("already Vietnamese news alerts are not translated or relabeled twice", async () => {
  const { formatNewsAlert } = require("../src/i18n");
  const telegram = new Telegram({ requestTimeoutMs:1000 });
  const alert = formatNewsAlert({
    assetName:"VÀNG", title:"Lạm phát Mỹ tăng",
    eventType:"inflation_hot", impactScore:-0.3, importance:8,
    source:"The Guardian", url:"https://example.test/news"
  }, { direction:"NEUTRAL", confidence:65 });
  const localized = await telegram.localizeMessage(alert);
  assert.equal((localized.match(/điểm chất lượng/g) || []).length, 1);
  assert.match(localized, /Sự kiện: Lạm phát cao hơn dự kiến/);
  assert.doesNotMatch(localized, /Sự kiện: Sự kiện khác/);
});

test("all Telegram message types remove source labels and raw article URLs", async () => {
  const telegram = new Telegram({ requestTimeoutMs:1000 });
  const samples = [
    "⚡ BIẾN ĐỘNG THỊ TRƯỜNG\\nVÀNG: TĂNG 1.2%\\nNguồn: Yahoo Finance",
    "BÁO CÁO\\nTin tức mới\\nNguồn: EnergyNow.com | https://news.google.com/rss/articles/example",
    "Thông báo\\nhttps://example.test/article"
  ];
  for (const sample of samples) {
    const output = await telegram.localizeMessage(sample);
    assert.doesNotMatch(output, /Nguồn:|Source:|http/i);
  }
});

test("queued news alerts remove source and link while preserving the analysis", async () => {
  const telegram = new Telegram({ requestTimeoutMs:1000 });
  const output = await telegram.localizeMessage([
    "🚨 TIN TỨC QUAN TRỌNG | DẦU (WTI / BRENT)",
    "Giá dầu biến động mạnh",
    "Sự kiện: geopolitical_escalation",
    "Tác động theo mô hình: TÍCH CỰC (0.9)",
    "Dự báo 24h sau cập nhật: NEUTRAL | điểm 65/82",
    "Mức độ: 10/10",
    "Nguồn: EnergyNow.com",
    "https://news.google.com/rss/articles/example"
  ].join("\\n"));
  assert.match(output, /DẦU/);
  assert.match(output, /Căng thẳng địa chính trị leo thang/);
  assert.match(output, /Mức độ quan trọng: 10\\/10/);
  assert.doesNotMatch(output, /EnergyNow|Nguồn:|http/);
});

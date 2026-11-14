"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { directionVi, eventVi, sourceVi, horizonVi, methodVi, formatNewsAlert, formatMarketAlert, errorVi } = require("../src/i18n");

test("internal forecast directions are displayed in Vietnamese", () => {
  assert.equal(directionVi("BULLISH"), "XU HƯỚNG TĂNG");
  assert.equal(directionVi("BEARISH"), "XU HƯỚNG GIẢM");
  assert.equal(directionVi("NEUTRAL"), "TRUNG LẬP");
});

test("internal event codes are displayed as readable Vietnamese labels", () => {
  assert.equal(eventVi("inflation_hot"), "Lạm phát cao hơn dự kiến");
  assert.equal(eventVi("geopolitical_escalation"), "Căng thẳng địa chính trị leo thang");
  assert.equal(eventVi("unclassified"), "Chưa phân loại sự kiện");
  assert.equal(eventVi("Lạm phát cao hơn dự kiến"), "Lạm phát cao hơn dự kiến");
});

test("source, horizon and model labels are Vietnamese", () => {
  assert.equal(sourceVi("Federal Reserve"), "Cục Dự trữ Liên bang Mỹ (Fed)");
  assert.equal(horizonVi("24h"), "24 giờ");
  assert.equal(methodVi("deterministic-quantitative"), "Mô hình định lượng theo quy tắc");
});

test("Telegram alert templates contain Vietnamese labels instead of internal English codes", () => {
  const news = formatNewsAlert({
    assetName:"VÀNG (XAUUSD)", title:"Lạm phát Mỹ cao hơn dự kiến trong tháng 10",
    eventType:"inflation_hot", impactScore:-0.3, importance:8,
    source:"The Guardian", url:"https://example.test/news"
  }, { direction:"NEUTRAL", confidence:65 });
  assert.match(news, /TRUNG LẬP/);
  assert.match(news, /Lạm phát cao hơn dự kiến/);
  assert.doesNotMatch(news, /inflation_hot|NEUTRAL|Nguồn:|https?:);
  assert.doesNotMatch(market, /Nguồn:|Yahoo Finance|https?:);

  const market = formatMarketAlert({
    instrumentName:"Vàng giao ngay", symbol:"XAUUSDm", changePercent:1.25, price:4200, source:"Yahoo Finance"
  });
  assert.match(market, /BIẾN ĐỘNG THỊ TRƯỜNG/);
  assert.match(market, /TĂNG 1.25%/);
});

test("technical network errors are described in Vietnamese", () => {
  assert.equal(errorVi(new Error("Network fetch failed (api.gdeltproject.org): UND_ERR_CONNECT_TIMEOUT")), "Không kết nối được tới api.gdeltproject.org (mã lỗi UND_ERR_CONNECT_TIMEOUT)");
  assert.equal(errorVi(new Error("HTTP 429 from api.example.com")), "Máy chủ api.example.com trả về mã HTTP 429");
});

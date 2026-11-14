"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { directionVi, eventVi, sourceVi, horizonVi, methodVi } = require("../src/i18n");

test("internal forecast directions are displayed in Vietnamese", () => {
  assert.equal(directionVi("BULLISH"), "TÍCH CỰC");
  assert.equal(directionVi("BEARISH"), "TIÊU CỰC");
  assert.equal(directionVi("NEUTRAL"), "TRUNG LẬP");
});

test("internal event codes are displayed as readable Vietnamese labels", () => {
  assert.equal(eventVi("inflation_hot"), "Lạm phát cao hơn dự kiến");
  assert.equal(eventVi("geopolitical_escalation"), "Căng thẳng địa chính trị leo thang");
  assert.equal(eventVi("unclassified"), "Chưa phân loại sự kiện");
});

test("source, horizon and model labels are Vietnamese", () => {
  assert.equal(sourceVi("Federal Reserve"), "Cục Dự trữ Liên bang Mỹ (Fed)");
  assert.equal(horizonVi("24h"), "24 giờ");
  assert.equal(methodVi("deterministic-quantitative"), "Mô hình định lượng theo quy tắc");
});

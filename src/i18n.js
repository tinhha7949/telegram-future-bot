"use strict";

const DIRECTIONS = {
  BULLISH:"TÍCH CỰC", BEARISH:"TIÊU CỰC", NEUTRAL:"TRUNG LẬP",
  positive:"TÍCH CỰC", negative:"TIÊU CỰC", neutral:"TRUNG LẬP"
};

const EVENTS = {
  fed_hawkish:"Fed có quan điểm thắt chặt", fed_dovish:"Fed có quan điểm nới lỏng",
  rate_hike:"Tăng lãi suất", rate_cut:"Giảm lãi suất",
  inflation_hot:"Lạm phát cao hơn dự kiến", inflation_cool:"Lạm phát hạ nhiệt",
  jobs_strong:"Thị trường lao động mạnh", jobs_weak:"Thị trường lao động suy yếu",
  growth_strong:"Tăng trưởng kinh tế mạnh", growth_weak:"Tăng trưởng kinh tế suy yếu",
  yield_up:"Lợi suất trái phiếu tăng", yield_down:"Lợi suất trái phiếu giảm",
  usd_up:"Đồng USD tăng giá", usd_down:"Đồng USD giảm giá",
  supply_disruption:"Gián đoạn nguồn cung", supply_increase:"Nguồn cung gia tăng",
  opec_cut:"OPEC cắt giảm sản lượng", opec_raise:"OPEC tăng sản lượng",
  inventory_build:"Lượng hàng tồn kho tăng", inventory_draw:"Lượng hàng tồn kho giảm",
  geopolitical_escalation:"Căng thẳng địa chính trị leo thang", ceasefire:"Ngừng bắn hoặc giảm căng thẳng",
  sanctions:"Áp đặt lệnh trừng phạt", tariffs:"Áp thuế quan thương mại",
  gold_demand:"Nhu cầu vàng gia tăng", gold_outflow:"Dòng vốn rút khỏi vàng",
  risk_off:"Tâm lý né tránh rủi ro", risk_on:"Tâm lý ưa thích rủi ro",
  earnings_strong:"Kết quả kinh doanh tích cực", earnings_weak:"Kết quả kinh doanh suy yếu",
  unclassified:"Chưa phân loại sự kiện", event:"Sự kiện"
};

const COMPONENTS = {
  news:"Tin tức", momentum:"Động lượng giá", crossMarket:"Tương quan thị trường",
  "USD/DXY":"Chỉ số sức mạnh đồng USD (DXY)",
  "US 10Y yield":"Lợi suất trái phiếu Mỹ kỳ hạn 10 năm"
};

const SOURCES = {
  "CNBC Markets":"CNBC - Thị trường",
  "MarketWatch":"MarketWatch - Tin thị trường",
  "Federal Reserve":"Cục Dự trữ Liên bang Mỹ (Fed)",
  "US Energy Information Administration":"Cơ quan Thông tin Năng lượng Mỹ (EIA)",
  "European Central Bank":"Ngân hàng Trung ương châu Âu (ECB)",
  "BBC Business":"BBC - Kinh doanh",
  "Deutsche Welle":"Đài DW",
  "Yahoo Finance":"Yahoo Finance",
  "Configured broker endpoint":"Nguồn dữ liệu do người dùng cấu hình"
};

function directionVi(value) { return DIRECTIONS[value] || value || "CHƯA CÓ DỮ LIỆU"; }
function eventVi(value) { return EVENTS[value] || (value ? String(value).replace(/_/g, " ") : EVENTS.unclassified); }
function componentVi(value) { return COMPONENTS[value] || value || ""; }
function sourceVi(value) { return SOURCES[value] || value || "Nguồn tin chưa xác định"; }
function horizonVi(value) {
  const map = { "24h":"24 giờ", "3d":"3 ngày", "7d":"7 ngày", "30d":"30 ngày" };
  return map[value] || value || "";
}
function methodVi(value) {
  return value === "deterministic-quantitative" ? "Mô hình định lượng theo quy tắc" : value || "";
}

module.exports = { DIRECTIONS, EVENTS, COMPONENTS, SOURCES, directionVi, eventVi, componentVi, sourceVi, horizonVi, methodVi };

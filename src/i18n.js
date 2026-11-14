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
  "Configured broker endpoint":"Nguồn dữ liệu do người dùng cấu hình",
  "Unknown":"Nguồn tin chưa xác định", "unknown":"Nguồn tin chưa xác định", "Google News":"Google Tin tức"
};

function directionVi(value) { return DIRECTIONS[value] || "CHƯA XÁC ĐỊNH"; }
function eventVi(value) { return EVENTS[value] || (value ? "Sự kiện khác" : EVENTS.unclassified); }
function componentVi(value) { return COMPONENTS[value] || value || ""; }
function sourceVi(value) { return SOURCES[value] || value || "Nguồn tin chưa xác định"; }
function horizonVi(value) {
  const map = { "24h":"24 giờ", "3d":"3 ngày", "7d":"7 ngày", "30d":"30 ngày" };
  return map[value] || (value ? "Khung thời gian khác" : "");
}
function methodVi(value) {
  return value === "deterministic-quantitative" ? "Mô hình định lượng theo quy tắc" : "Mô hình phân tích";
}


function formatNewsAlert(item, forecast) {
  const impact = Number(item.impactScore || 0);
  const impactLabel = impact > 0 ? "TÍCH CỰC" : impact < 0 ? "TIÊU CỰC" : "CHƯA RÕ";
  const outlook = forecast ? directionVi(forecast.direction) + " | điểm chất lượng " + forecast.confidence + "/82" : "Chưa đủ dữ liệu";
  return "🚨 TIN TỨC QUAN TRỌNG | " + item.assetName + "\n" + item.title +
    "\nSự kiện: " + eventVi(item.eventType) +
    "\nTác động theo mô hình: " + impactLabel + " (" + impact.toFixed(1) + ")" +
    "\nDự báo 24 giờ sau khi cập nhật: " + outlook +
    "\nMức độ quan trọng: " + item.importance + "/10" +
    "\nNguồn: " + sourceVi(item.source) + "\n" + item.url;
}

function formatMarketAlert(item, config = {}) {
  const direction = item.changePercent >= 0 ? "TĂNG" : "GIẢM";
  const name = item.instrumentName || (config.symbolLabels || {})[item.symbol] || item.symbol;
  return "⚡ BIẾN ĐỘNG THỊ TRƯỜNG\n" + name + " (" + item.symbol + "): " + direction + " " +
    Number(item.changePercent).toFixed(2) + "%\nGiá tham chiếu: " + item.price +
    "\nNguồn: " + sourceVi(item.source || "Yahoo Finance");
}

function errorVi(error) {
  const message = String(error && error.message || error || "Lỗi không xác định");
  let match = message.match(/HTTP (\d+) from ([a-z0-9.-]+)/i);
  if (match) return "Máy chủ " + match[2] + " trả về mã HTTP " + match[1];
  match = message.match(/Network fetch failed \(([^)]+)\): ([A-Z0-9_]+)/i);
  if (match) return "Không kết nối được tới " + match[1] + " (mã lỗi " + match[2] + ")";
  match = message.match(/Request timeout after (\d+)ms \(([^)]+)\)/i);
  if (match) return "Hết thời gian chờ " + match[1] + " mili giây khi kết nối tới " + match[2];
  const aborted = message.match(/Request aborted \(([^)]+)\)/i);
  if (aborted) return "Kết nối tới " + aborted[1] + " đã bị hủy";
  if (/Yahoo Finance is in a temporary rate-limit cooldown/i.test(message)) return "Yahoo Finance đang tạm giới hạn số lần truy cập";
  if (/Yahoo Finance returned no chart data/i.test(message)) return "Yahoo Finance không trả về dữ liệu biểu đồ";
  if (/Too Many Requests|rate limit/i.test(message)) return "Nguồn dữ liệu đang giới hạn số lần truy cập";
  if (/Telegram trả về mã lỗi HTTP (\d+)/i.test(message)) return "Telegram trả về mã lỗi HTTP " + message.match(/HTTP (\d+)/i)[1];
  if (/Bad Request/i.test(message)) return "Telegram từ chối tin nhắn do nội dung hoặc tham số không hợp lệ";
  if (/chat not found/i.test(message)) return "Không tìm thấy cuộc trò chuyện Telegram; hãy kiểm tra CHAT_ID";
  if (/Unauthorized/i.test(message)) return "Telegram từ chối mã truy cập; hãy kiểm tra BOT_TOKEN";
  if (/MongoServerSelectionError|MongoNetworkError/i.test(message)) return "Không kết nối được tới cơ sở dữ liệu MongoDB";
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(message)) return "Lỗi kết nối mạng: " + message.match(/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/)[0];
  return "Lỗi kỹ thuật: " + message;
}
module.exports = { DIRECTIONS, EVENTS, COMPONENTS, SOURCES, directionVi, eventVi, componentVi, sourceVi, horizonVi, methodVi, formatNewsAlert, formatMarketAlert, errorVi };

# Sửa lỗi quản lý vị thế — 22/10/2026

## Nguyên nhân và bản sửa

| Lỗi | Nguyên nhân | Hành vi sau sửa |
| --- | --- | --- |
| Binance báo illegal characters ở startTime | Đồng bộ đồng hồ lấy midpoint có thể sinh offset nửa mili giây. submittedAt lưu phần lẻ và đi vào truy vấn lịch sử fill | Chuẩn hóa startTime/endTime/timestamp/recvWindow thành số nguyên trước ký; submittedAt mới lưu nguyên; dữ liệu cũ có phần lẻ vẫn đọc được; chặn thời gian vô hạn/không hợp lệ |
| TP2 còn sau khi SL đã đóng vị thế | finish chỉ hủy algo ở cuối, sau phí/funding/MAE/MFE và các lần ghi DB | Xác minh flat bằng snapshot mới rồi hủy và kiểm tra lệnh dư trước mọi bước đối soát. Áp dụng SL, TP2, timeout và đóng giảm vị thế |
| Lỗi đối soát làm ngừng quét toàn bộ | Lỗi lịch sử của lệnh đã đóng bị gắn POSITION_STATE_UNCERTAIN | Sau khi xác nhận dọn sạch, chỉ báo CLOSED TRADE ACCOUNTING PENDING; giữ bản ghi pending để thử lại. Lỗi trạng thái/cleanup thật vẫn chặn entry |
| TP cũ không còn bản ghi pending | Không có vòng dọn orphan | Hủy từng conditional order có client ID của Nine-AI trên symbol flat; xác minh lại và bỏ qua symbol đang có exposure hoặc đang mở lệnh |
| Restart sau TP1 khi hai mục tiêu bằng nhau và sibling bị hủy | Sửa TP2 trước khi phục hồi trạng thái TP1 đã khớp | Đối soát cả hai nửa trước khi thay sibling; không bán lại nửa đã chốt |
| Restart khi đang đóng | initialize đổi CLOSING thành NEEDS_PROTECTION | Giữ trạng thái đóng và deadline để tiếp tục đóng phần còn lại |
| TP AI-2 lệch khỏi vùng cấu trúc sau fill | Cộng khoảng cách TP dự tính vào entry mới | Giữ mức cấu trúc đã lập; AI-7 vẫn tính phân vị theo entry khớp thực |
| Timeout lệch theo đồng hồ local | Deadline từ sàn được so với giờ local chưa bù offset | So sánh bằng đồng hồ đã đồng bộ với sàn |

## Đối chiếu logic

- Risk giữ nguyên tại biến người dùng chỉnh trong index.js.
- Khi có nhãn thắng dùng được theo setup: SL = p80 MAE lệnh thắng; TP1/TP2 = p50/p90 MFE toàn bộ nhãn hợp lệ. Khi chưa có nhãn: dùng kế hoạch cấu trúc của AI-2. Không thêm ngưỡng số mẫu mới.
- TP1 gửi reduceOnly với một nửa khối lượng khớp gốc; khối lượng được kiểm tra theo bước sàn. TP2 quản lý phần còn lại. Khi hai giá phân vị trùng nhau, dùng hai lệnh nửa riêng biệt. Khóa lãi ở đây là chốt phần TP1, không thêm quy tắc dời SL.
- AI-9 tiếp tục dùng một công thức edge; Flow không tự tạo hướng; regime không xu hướng trả WAIT theo pseudocode; học hằng ngày vẫn qua calibration, walk-forward purge/embargo và shadow hai tuần trước promotion.
- Dọn tất cả symbol đã flat trước khi đối soát từng lệnh; nếu dữ liệu chưa đầy đủ thì không tạo nhãn giả. Lệnh cùng symbol vẫn bị khóa cho đến khi hoàn tất đối soát.

## Kiểm chứng

135 bài kiểm thử đã qua bằng npm test trên Node.js 24; CI kiểm tra lại trên Node.js 22. Bộ mới bổ sung Long/Short; SL trước TP1; TP1 chốt nửa rồi SL; TP2; timeout; restart trước đối soát; lỗi fills/funding/fee conversion/database/candle history; TP trùng nhau và mất sibling; orphan; lệnh con; từ chối hủy khi còn exposure; timestamp có phần lẻ và thời gian không hợp lệ. Các kiểm thử AI-1 đến AI-9, accounting, học offline và transport hiện có vẫn qua.

Kiểm thử dùng sàn và database giả lập, không gửi lệnh thật hay sửa database VPS. Chu kỳ quản lý bình thường là 10 giây; thao tác dọn xảy ra ở lượt quản lý thành công tiếp theo, có thể chậm khi Binance/network bị gián đoạn. MAE/MFE vẫn có độ phân giải nến 1 phút cộng giá quan sát ở phút vào/ra, không phải toàn bộ tick. Xác suất ban đầu và slippage là ước lượng công thức như bản hiện tại.

Đã đối chiếu [Binance USD-M REST trade API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade): thời gian là integer int64; userTrades không trộn fromId với startTime/endTime và mỗi cửa sổ tối đa 7 ngày; conditional orders dùng API algo riêng, lệnh con dùng API order; query/cancel algo chỉ gửi các định danh được tài liệu hóa.

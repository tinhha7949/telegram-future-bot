# Đối soát entry thiếu dữ liệu khớp

## Log được báo

ENTRY_FILL_NOT_CONFIRMED nghĩa là bot không có khối lượng và giá khớp dương/hữu hạn để dựng kế hoạch theo entry thật. Log cũ không chứa các trường phản hồi nên chưa thể xác định chính xác KMNO/BARD thiếu trường nào hoặc nguyên nhân tại Binance. Không được coi dòng này là bằng chứng lệnh chưa khớp hay vị thế không tồn tại.

## Sửa luồng xử lý

- Trạng thái FILLED nhưng thiếu giá/khối lượng/thời gian hợp lệ cũng được query lại bằng cùng client order ID, tối đa năm lần, không chỉ chờ những trạng thái NEW/PARTIALLY_FILLED.
- Nếu phản hồi vẫn thiếu, tra userTrades theo symbol + orderId, chỉ tổng hợp các execution đúng lệnh và đúng hướng. Bỏ fill trùng ID; đối chiếu đủ tổng khối lượng; dùng giá bình quân gia quyền và thời gian fill đầu tiên. Không dùng mark price hoặc entry kế hoạch thay cho giá thực.
- Nếu vẫn không xác minh được sau các bước trên: giữ claim/vị thế trong danh sách quản lý, chặn mở thêm lệnh, lưu trạng thái và các trường phản hồi cần chẩn đoán. Nếu sàn xác nhận còn exposure thì đóng reduce-only bằng đúng lượng hiện có. Nếu đóng không thành công, giữ trạng thái pending và thử lại ở vòng bảo vệ tiếp theo.
- Query lỗi sau một MARKET POST mơ hồ không được đổi thành từ chối chắc chắn. Giữ ambiguity để phục hồi, không phát lại MARKET entry.
- Claim có từ trước crash vẫn được quản lý ngay cả khi chưa phục hồi đủ fill. Khi dữ liệu về đủ, ghi kết quả thực, phí/funding/MAE/MFE theo luồng bình thường; không tạo nhãn giả hay mở lại cùng signal.

Nguồn API: [Binance New Order/Query Order/Account Trade List](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade). RESULT được tài liệu mô tả trả kết quả khớp cuối của MARKET; bản sửa bổ sung xử lý phòng vệ cho phản hồi thiếu/không hợp lệ được ghi nhận bởi ứng dụng.

## Các dòng khác

- 524 symbols, 6 signals và 518 WAIT là tổng nhất quán. Các lý do EDGE_BELOW_THRESHOLD/REGIME_NOT_TREND/thiếu lịch sử/HOT_FUNDING là kết quả quyết định, không tự chứng minh lỗi transport.
- Margin is insufficient là sàn từ chối vì margin khả dụng không đủ. Không tự đổi risk, leverage hay thu nhỏ khối lượng để ép khớp lệnh.
- ENTRY_PLAN_ALREADY_CROSSED là mark hiện tại không còn nằm giữa SL và TP1 theo hướng lệnh. Giữ cơ chế bỏ qua kế hoạch đã bị vượt.
- Calibration với ba mẫu chỉ mô tả ba dự báo/kết quả đã đóng. Code hiện gắn RED_FLAG khi MAE của sai số R lớn hơn 0; đây không phải kiểm định có ý nghĩa thống kê. Không thay công thức/champion hay tự chỉnh tham số từ ba mẫu. Candidate cần cơ hội đủ horizon 24 nến và walk-forward; shadow chỉ bắt đầu sau khi candidate đủ điều kiện.

164 kiểm thử đã qua trên máy phát triển, gồm phản hồi FILLED thiếu giá, fallback fill history Long/Short, lịch sử thiếu/trùng/nhầm lệnh, pending claim sau crash, chặn entry tiếp và đóng exposure chưa xác minh rồi đối soát khi dữ liệu về. Kiểm thử dùng dữ liệu giả; không truy cập VPS hoặc tài khoản giao dịch thật. CI kiểm tra lại trên Node.js 22. Risk và số coin quét không thay đổi; giữ HISTORY_4H_LIMIT = 1000 theo commit mới của người dùng. Kiểm thử transport đọc cấu hình này thay vì khóa cứng 1500.

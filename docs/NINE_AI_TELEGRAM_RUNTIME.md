# Telegram và vận hành dài ngày

## Đích thông báo

| Sự kiện | Cấu hình đích | Nội dung |
| --- | --- | --- |
| Mở lệnh đã khớp và xác nhận bảo vệ SL/TP | Telegram 1: BOT_TOKEN + CHAT_ID | Symbol, LONG/SHORT, khối lượng khớp, entry thực, SL, TP1 chốt 50%, TP2, nguồn AI2/AI7, timeout và mã lệnh |
| Đóng lệnh đã đối soát | Telegram 2: BOT_TOKEN_2 + AI_CHAT_ID | WIN/LOSS, PnL ròng USDT và R |
| Cảnh báo trạng thái, dung lượng DB | Telegram 2 với fallback hiện có về Telegram 1 | Cảnh báo vận hành, không tự tạo hướng giao dịch |
| /status | Telegram 1 | Trạng thái bot và tạm dừng entry |

Trước bản sửa, cả mở lệnh và kết quả đều dùng hàm report ưu tiên Telegram 2. Nay sự kiện mở lệnh được phát tại lifecycle sau khi khớp và xác nhận SL/TP, kể cả phục hồi sau restart; không chỉ phụ thuộc scanner. Entry lỗi hoặc thiếu bảo vệ không được thông báo như lệnh thành công. Nếu thiếu BOT_TOKEN/CHAT_ID, thông báo entry chờ trong DB và có log MISSING_DESTINATION, không âm thầm gửi sang Telegram 2.

## Gửi lại và lưu trữ

Collection telegram_notification_outbox lưu nội dung và khóa ENTRY:<signalKey>/CLOSED:<signalKey>, không lưu token. Mã sự kiện cố định ngăn tạo nhiều bản ghi khi tick/restart thử lại. Vòng gửi riêng hai giây dùng timeout HTTP mười giây, giữ lỗi mạng/API ở PENDING, tuân thủ retry_after của Telegram và backoff khi lỗi. Sự cố ở một đích không ngăn thử đích còn lại. Thông báo đã xác nhận gửi có TTL 30 ngày; thông báo đang chờ không bị TTL xóa. Lỗi 400/401/403/404 cần kiểm tra cấu hình/quyền, được thử lại sau một giờ và có log mã lỗi.

Telegram sendMessage không có khóa idempotency cho người gửi. Nếu Telegram đã nhận tin nhưng phản hồi bị mất hoặc DB chưa ghi nhận thành công thì một lần thử lại có thể tạo tin trùng. Không thể cam kết exactly-once ở tình huống đó; việc gửi lệnh giao dịch không bị lặp bởi cơ chế gửi tin.

Đối chiếu [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage) và [ResponseParameters](https://core.telegram.org/bots/api#responseparameters). Kiểm thử dùng HTTP giả lập, không gửi tin thử ra tài khoản thật.

## Các lỗi vận hành được sửa trong đợt này

- HTTP 400 với Binance -1006/-1007 vẫn là trạng thái thực thi chưa rõ. Query lại cùng client order ID; không đánh dấu từ chối rồi bỏ theo dõi, không gửi lại MARKET một cách mù quáng.
- Vòng bảo vệ/timeout tách khỏi vòng phí/funding/MAE/MFE. Chờ dữ liệu lịch sử không giữ khóa vòng bảo vệ. Snapshot DB của cùng lệnh được ghi nối tiếp để tránh một ghi nền cũ đè lên trạng thái CLOSING mới.
- Ghi trạng thái cuối bị lỗi không được coi như SL/TP trên sàn đã mất. Khi bảo vệ đã được xác nhận, giữ vị thế và tạm dừng entry đến khi trạng thái được lưu lại. Việc lưu client ID trước khi gửi lệnh bảo vệ mới vẫn bắt buộc.
- Lỗi queue cảnh báo không được ngắt vòng quản lý. Thông báo đóng lệnh được xếp hàng trước khi bỏ bản ghi khỏi danh sách đang xử lý, để còn thử lại nếu DB queue bị lỗi.
- Lỗi chuẩn bị một symbol không bỏ qua các tín hiệu còn lại. Kiểm tra lại trạng thái stop/pause sau các thao tác chờ trước khi mở lệnh.
- Khi dung lượng DB sau dọn vẫn vượt ngưỡng, gửi cảnh báo Telegram 2. Không tự rút ngắn chính sách lưu dữ liệu hoặc xóa dữ liệu học chỉ để ép xuống giới hạn. Nếu dung lượng tăng do dữ liệu còn trong hạn lưu thì cần tăng dung lượng hoặc thay đổi chính sách có chủ đích.

157 bài kiểm thử đã qua trên máy phát triển, gồm tích hợp lifecycle → outbox → HTTP giả lập cho entry và SL, lỗi 429/mất mạng/restart, query cùng ID sau Binance -1006/-1007, timeout khi lịch sử đang bị giữ, lỗi ghi DB khi đã có bảo vệ và ghi snapshot đồng thời. Đã đối chiếu [mã lỗi Binance](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/error-code). CI kiểm tra lại trên Node.js 22.

Risk và logic AI2/AI7/AI9 không thay đổi trong đợt này. Các bài kiểm thử không thay thế giám sát VPS, dung lượng database và trạng thái API thật.

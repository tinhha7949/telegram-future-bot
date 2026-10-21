# Đối chiếu bản thiết kế 9 AI

## Quy tắc đặt SL/TP

- Khi AI-7 dùng được: SL chỉ lấy phân vị MAE p80; TP1/TP2 chỉ lấy MFE p50/p90. Không trộn hỗ trợ, kháng cự hoặc ATR vào SL AI-7. Mức giá được tính lại theo entry khớp thực tế; làm tròn SL về phía entry theo tick của sàn, không nới xa phân vị.
- Khi chưa có dữ liệu phân vị thắng dùng được: dùng tạm AI-2 như người dùng đã cho phép. Không giả lập các nhãn thành lệnh thật và không thêm điều kiện đủ 30 lệnh thắng.
- AI-7 gom MAE/MFE theo regime/setup; không tự bắt thêm cùng coin hoặc cùng hướng. Xác suất của một hướng vẫn học từ kết quả của chính hướng đó, đúng p(a).
- TP1 đóng 50%, TP2 phần còn lại; hai phân vị bằng nhau vẫn có hai lệnh chốt nửa vị thế được theo dõi riêng. Timeout 24 nến/96h và biến risk đầu index.js được giữ theo thiết kế.

## Những điều kiện ngoài thiết kế đã gỡ

| Phần | Đã gỡ | Luồng hiện tại |
| --- | --- | --- |
| AI-1 | Sàn momentum 1,2% riêng | Momentum cùng pha xác định hướng, volatility theo phân vị |
| AI-2 | Fractal 5 nến và quyền phủ quyết theo bias | Fractal giữa 2 nến kề; bias/vùng giá là đầu ra |
| AI-3 | Bắt thêm volume, thân nến tối thiểu theo ATR, OI bắt buộc tăng | Pullback + đẩy xác nhận đúng trend; funding/OI tham gia ước lượng |
| AI-4 | Spread 0,15% như veto riêng; volume phải nở 25%; đuổi giá đo bằng ATR | Volume nở trên range, bar xác nhận giữ vùng, không vượt cả độ rộng range; spread vào p/chi phí |
| AI-6 | Bắt liquidation cùng hướng mới cho vào | Confirmation là thông tin; funding nóng chặn lệnh |
| AI-7 | SL lai cấu trúc/ATR, nhóm riêng theo coin/hướng, số mẫu tối thiểu | Phân vị setup, SL/TP đúng công thức |
| AI-9 | Ưu tiên Continuation trước Breakout, trộn track-record 50/50 sau 20 mẫu thắng | Chọn setup/hướng bằng cùng công thức edge; track-record cập nhật xác suất |
| Dữ liệu | Cửa sổ cứng 5 phút/30 giây và cửa sổ OI 8 giờ | Dữ liệu già làm tăng uncertainty; dữ liệu thiếu/không thể tính không bị bịa |
| Danh sách coin | Turnover 5 triệu, biên độ 3%, top 80, blacklist stablecoin | Các USDT perpetual đang giao dịch |
| Khởi tạo | Veto 2 vị thế AI2_INITIAL riêng | Không thêm veto này vào quyết định; giới hạn tài khoản hiện có vẫn áp dụng |
| Học hằng ngày | 400/30/20 mẫu, thêm 0,02R uplift, chờ cứng 18 ngày, bỏ candidate ở ngày 21 | Cùng cơ hội/chi phí, walk-forward purge/embargo, shadow đủ 2 tuần và nhãn chín, chỉ thay khi thắng |

## Các phép ước lượng được khai báo

Bản mô tả cho biết các đại lượng phải tính nhưng không cung cấp toàn bộ hệ số số học. Source công khai cách tính confidence, xác suất ban đầu, slippage, độ già dữ liệu, minEdge/gapEdge và định nghĩa funding nóng. Đây là các phép ước lượng bên trong vai trò tương ứng, không phải một tầng chọn lệnh bổ sung. Xác suất ban đầu được đánh dấu chưa calibration; không mô tả các công thức hiện tại thành chín mô hình ML đã được train riêng.

Vòng live ngoài regime không xu hướng vẫn WAIT theo đúng pseudocode người dùng, vì vậy Mean Reversion chỉ xuất phân tích trong RANGE/HIGH_VOL. Không tự mở lệnh mean-reversion trái với bước WAIT đó.

## Kiểm thử đối chiếu

nine-ai-spec.test.js kiểm tra trực tiếp SL/TP phân vị trước/sau fill, pooling theo setup, MAE bằng 0 không bị thay bằng ATR, fractal 3 nến, liquidation không tạo veto, Continuation không nhận thêm bộ lọc volume/OI, Breakout giữ vùng, chọn setup bằng edge, stale penalty, danh sách coin và loại cache cũ.

Các bài kiểm tra lifecycle/accounting giữ nguyên yêu cầu chốt nửa, restart, timeout, đối soát fee/funding/slippage/R và bổ sung phục hồi dữ liệu MAE/MFE thiếu. Các bài kiểm tra học xác nhận candidate có thể thắng với ít cơ hội và uplift dương nhỏ, calibration không cần đợi 30 lệnh, shadow đủ 14 ngày có thể promote khi mọi nhãn đã chín. Chưa dùng VPS hay tài khoản thật để thực thi lệnh trong quá trình kiểm thử.

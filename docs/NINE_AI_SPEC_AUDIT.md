# Đối chiếu bản thiết kế 9 AI

## Khung nến ra quyết định

Chỉ dùng nến 4h đã đóng để phân tích và ra quyết định. Regime, structure và các setup dùng cùng lịch sử 4h; không tải nến khung khác để xác nhận trend hoặc phạt dữ liệu cũ. Volatility 20/90 ngày lần lượt lấy 120/540 biến động giá từ nến 4h. Momentum 5/20 ngày cũng lấy từ 30/120 nến 4h. Lịch học mỗi ngày vẫn giữ như thiết kế; đây là lịch chạy công việc, không phải một khung nến phân tích.

Cache/quyết định và candidate từ phiên bản trước được giữ để tra cứu, không tái sử dụng trong engine phiên bản 5. Tham số champion cũ được lưu lại, phiên bản mới khởi tạo từ các ngưỡng mặc định đã công khai. Nhãn MAE/MFE thật vẫn được dùng; không đổi SL/TP đã lưu của vị thế đang mở.

## Kết quả rà soát lần nữa

| Yêu cầu | Cách thực hiện và bằng chứng |
| --- | --- |
| Một công thức AI-9 | p × E[R] − fee − funding − slippage − penalty; chi phí cùng đơn vị R; so sánh ngưỡng và gap bằng dấu > nghiêm ngặt |
| E[R theo hướng/regime/setup] | Trung bình gross R thực, có cả thắng và thua, từ track-record/nhãn đã đóng trước quyết định; chỉ khi chưa có R thực mới dùng ước lượng khởi tạo từ kế hoạch thoát |
| MAE p80 của nhãn thật cùng setup/hướng | Lấy MAE từ toàn bộ nhãn đóng hợp lệ cùng setup/hướng, gồm thắng và thua; không trộn cấu trúc/ATR vào SL khi AI-7 đã có dữ liệu |
| MFE p50/p90 của lệnh đã label | Lấy cả lệnh thắng lẫn thua; đã gỡ điều kiện chỉ lấy lệnh thắng cho TP |
| Cost đúng dấu | Funding trả là chi phí dương, nhận là khoản âm; live, kiểm tra trước lệnh và đánh giá offline cùng cách tính |
| Calibration | predicted_R = p × E[R] − cost; lưu riêng edge đã trừ uncertainty; không dùng edge thay predicted_R |
| Huấn luyện candidate | Chọn minEdge/gapEdge bằng điểm train; kiểm tra thắng champion trên validation và test đã purge/embargo; giữ nguyên tham số qua shadow hai tuần |
| Không lọc lệnh bằng giới hạn ngoài thiết kế | Đã bỏ top-10, một lệnh mỗi lượt quét, cooldown và trần 20 vị thế; vẫn ngăn gửi trùng hoặc hai vị thế chồng lên cùng symbol |
| Point-in-time | Track-record, nhãn và calibration loại thời điểm đóng sau cutoff; cache không được đưa dữ liệu tương lai vào quyết định cũ |

nine-ai-expectancy.test.js kiểm các nhóm thắng/thua cho phân vị và E[R], calibration tách penalty, funding được nhận, loại dữ liệu tương lai, migration champion và thực thi nhiều tín hiệu qua vị trí thứ 10. opportunity-outcome.test.js kiểm thêm cùng chi phí funding có dấu ở offline. nine-ai-offline-learning.test.js có trường hợp candidate thắng train nhưng thua validation để xác nhận không lấy kết quả test về cứu candidate.

## Quy tắc đặt SL/TP

- Khi AI-7 dùng được: SL lấy MAE p80, TP1/TP2 lấy MFE p50/p90 từ nhãn thật hợp lệ cùng setup/hướng, bao gồm cả lệnh thắng và thua. Không trộn hỗ trợ, kháng cự hoặc ATR vào SL AI-7. Mức giá được tính lại theo entry khớp thực tế; làm tròn SL về phía entry theo tick của sàn, không nới xa phân vị.
- Khi chưa có nhãn thật hợp lệ: dùng kế hoạch khởi tạo AI-2 với SL = 1,5 × ATR14 theo cấu hình hiện hành. Không giả lập nhãn thành lệnh thật và không chờ đủ 30 nhãn mới bật AI-7.
- AI-7 gom MAE/MFE theo regime/setup; không tự bắt thêm cùng coin hoặc cùng hướng. Xác suất của một hướng vẫn học từ kết quả của chính hướng đó, đúng p(a).
- TP1 đóng 60%, TP2 đóng 40% theo `CONFIG.TP_BATCHES` hiện tại. Timeout 24 nến/96h lấy từ `CONFIG.TIMEOUT_BARS`. Các giá trị cấu hình và rủi ro hiện hữu được giữ nguyên, không bị hardcode lại trong bản rà soát này.

## Những điều kiện ngoài thiết kế đã gỡ

| Phần | Đã gỡ | Luồng hiện tại |
| --- | --- | --- |
| AI-1 | Sàn momentum 1,2% riêng và xác nhận từ khung nến khác | Chỉ lịch sử 4h; momentum cùng pha xác định hướng, volatility theo phân vị |
| AI-2 | Fractal 5 nến và quyền phủ quyết theo bias | Fractal giữa 2 nến kề; bias/vùng giá là đầu ra |
| AI-3 | Bắt thêm volume, thân nến tối thiểu theo ATR, OI bắt buộc tăng | Pullback + đẩy xác nhận đúng trend; funding/OI tham gia ước lượng |
| AI-4 | Spread 0,15% như veto riêng; volume phải nở 25%; đuổi giá đo bằng ATR | Volume nở trên range, bar xác nhận giữ vùng, không vượt cả độ rộng range; spread vào p/chi phí |
| AI-6 | Bắt liquidation cùng hướng mới cho vào | Confirmation là thông tin; funding nóng chặn lệnh |
| AI-7 | SL lai cấu trúc/ATR, nhóm riêng theo coin/hướng, số mẫu tối thiểu | Phân vị setup, SL/TP đúng công thức |
| AI-9 | Ưu tiên Continuation trước Breakout, trộn track-record 50/50 sau 20 mẫu thắng | Chọn setup/hướng bằng cùng công thức edge; track-record cập nhật xác suất |
| Dữ liệu | Cửa sổ cứng 5 phút/30 giây và cửa sổ OI 8 giờ | Dữ liệu già làm tăng uncertainty; dữ liệu thiếu/không thể tính không bị bịa |
| Danh sách coin | Turnover 5 triệu, biên độ 3%, top 80, blacklist stablecoin | Các USDT perpetual đang giao dịch |
| Khởi tạo/thực thi | Veto 2 vị thế AI2_INITIAL, trần 20 vị thế, top-10, một lệnh/lượt và cooldown | Mọi quyết định đủ edge đều được xét; chỉ còn kiểm tra tài khoản, giá/khối lượng hợp lệ và chống trùng |
| Học hằng ngày | 400/30/20 mẫu, thêm 0,02R uplift, chờ cứng 18 ngày, bỏ candidate ở ngày 21 | Cùng cơ hội/chi phí, walk-forward purge/embargo, shadow đủ 2 tuần và nhãn chín, chỉ thay khi thắng |

## Các phép ước lượng được khai báo

Bản mô tả cho biết các đại lượng phải tính nhưng không cung cấp toàn bộ hệ số số học. Source công khai cách tính confidence, xác suất ban đầu, slippage, độ già dữ liệu, minEdge/gapEdge và định nghĩa funding nóng. Xác suất ban đầu và slippage là ước lượng bằng công thức; vòng candidate huấn luyện ngưỡng quyết định minEdge/gapEdge. Không mô tả các hệ số này như đã được người dùng quy định hoặc đã được chứng minh dự báo chính xác.

Các định nghĩa số đang lấy từ cấu hình: high-vol từ phân vị 0,8; momentum từ 30/120 nến 4h; range breakout 20 nến, volume > trung bình và nến tiếp theo giữ vùng, không đuổi sau một độ rộng range; funding nóng khi trị tuyệt đối >= `CONFIG.FUNDING_HOT` (hiện là 0,0005 mỗi kỳ); `MIN_EDGE` hiện là 0,15R, `EARLY_MIN_EDGE` là 0,30R và `EDGE_GAP` là 0,05R. `EARLY_PHASE_LABELS` hiện là 30 nhưng `ADAPT_PHASE_LABELS` hiện là 100; vì yêu cầu giữ nguyên cấu hình hiện tại, chuyển pha MATURE theo file cấu hình hiện tại bắt đầu từ 100 nhãn, không phải 150. Có thể đặt `ADAPT_PHASE_LABELS: 150` trong cấu hình nếu muốn mốc MATURE là 150. Đây là cách lượng hóa các khái niệm chưa có ngưỡng số trong mô tả, không thể tuyên bố người dùng đã chỉ định chính xác chúng.

Các nến 1 phút còn lại chỉ phục vụ đo MAE/MFE khi có vị thế và quy đổi phí; không tạo tín hiệu vào lệnh. Đo biên phút vào/ra dùng giá quan sát, không phải toàn bộ tick. Chi phí funding tương lai và slippage là dự báo; log đóng lệnh dùng phí/funding thực. Kiểm thử không thay thế việc xác minh vận hành trên VPS/sàn thật.

Vòng live ngoài regime không xu hướng vẫn WAIT theo đúng pseudocode người dùng, vì vậy Mean Reversion không thể tự mở lệnh trong RANGE/HIGH_VOL. Đây là giới hạn có chủ ý của gate AI-1, dù module mean-reversion vẫn được mô tả và kiểm thử.

## Kiểm thử đối chiếu

nine-ai-spec.test.js kiểm tra trực tiếp SL/TP phân vị trước/sau fill, pooling theo setup, MAE bằng 0 không bị thay bằng ATR, fractal 3 nến, liquidation không tạo veto, Continuation không nhận thêm bộ lọc volume/OI, Breakout giữ vùng, chọn setup bằng edge, stale penalty, danh sách coin và loại cache cũ. nine-ai-pipeline.test.js xác nhận LONG/SHORT chỉ cần nến 4h, kiểm độc lập volatility 120/540 returns, momentum cùng lịch sử 4h và loại nến chưa đóng.

Các bài kiểm tra lifecycle/accounting giữ nguyên yêu cầu chốt nửa, restart, timeout, đối soát fee/funding/slippage/R và bổ sung phục hồi dữ liệu MAE/MFE thiếu. Các bài kiểm tra học xác nhận candidate có thể thắng với ít cơ hội và uplift dương nhỏ, calibration không cần đợi 30 lệnh, shadow đủ 14 ngày có thể promote khi mọi nhãn đã chín. Chưa dùng VPS hay tài khoản thật để thực thi lệnh trong quá trình kiểm thử.

# Two-Tower -> GA Planner: Ngữ Cảnh Và Hướng Thiết Kế

## 1. Vai trò của từng tầng

Trong luồng tạo lịch trình, Two-Tower và GA không giải quyết cùng một câu hỏi.

```text
Two-Tower:
"Những địa điểm nào có vẻ hợp với người dùng/chuyến đi này?"

GA / Planner:
"Sắp các địa điểm đó thành lịch trình thật sự đi được không,
đúng giờ không, đúng bữa ăn không, đúng budget không,
có hợp ngữ cảnh du lịch không?"
```

Luồng hiện tại:

```text
Mobile UI
-> API Service NestJS
-> Two-Tower lấy top-k địa điểm phù hợp
-> lấy chi tiết địa điểm từ DB
-> AI Service FastAPI chạy GA
-> trả lịch trình
-> nếu gọi UI thật thì lưu DB
-> nếu gọi preview thì chỉ in/lưu JSON debug
```

Nói ngắn gọn:

```text
Two-Tower chọn "địa điểm nên đi".
GA biến danh sách đó thành "lịch trình thật sự đi được".
```

## 2. Vấn đề hiện tại

Two-Tower trả địa điểm hợp sở thích, nhưng chưa đảm bảo lịch trình thực tế hợp lý.

Các vấn đề đã gặp:

- Lịch trình nhiều ngày có thể bị ngày cuối ít điểm hoặc 0 điểm.
- Một số intent như `Nghỉ dưỡng & Biển` ở TP.HCM trả ít attraction thật, dù tổng candidate vẫn nhiều.
- Cafe từng bị gộp vào restaurant, làm GA hiểu sai bữa chính.
- Restaurant cần dùng cho bữa trưa/bữa tối; cafe chỉ nên là bữa nhẹ.
- GA cần hiểu thêm ngữ cảnh du lịch thật: giờ nên đi, giờ ăn, hotel, travel time, budget.
- Output console ban đầu khó đọc, nên cần preview endpoint và JSON debug.

## 3. Những chỉnh sửa đã có

Đã thêm endpoint preview:

```text
POST /itinerary/plan/preview?top_k=...
```

Endpoint này:

- Chạy Two-Tower -> GA.
- Không lưu DB.
- Dùng để test nhanh bằng terminal.

Đã thêm JSON debug/log gồm:

- Số lượng candidate Two-Tower.
- Số lượng từng loại địa điểm.
- Thời gian chạy từng tầng:
  - Two-Tower
  - AI total
  - Goong matrix
  - GA
- Lịch trình chi tiết từng ngày.

JSON debug được lưu tại:

```text
api-service/logs/itinerary-plan-debug
```

Đã tách loại địa điểm:

```text
restaurant: bữa chính
cafe: bữa nhẹ
entertainment: vui chơi
attraction: tham quan
hotel: lưu trú
```

Điều này quan trọng vì cafe không được tính là bữa trưa/bữa tối chính.

## 4. best_time_of_day

`best_time_of_day` rất đáng thêm vào dữ liệu địa điểm, nhưng không nên dùng như ràng buộc cứng cho mọi địa điểm.

Đề xuất field:

```yaml
best_time_of_day:
  - morning
  - noon
  - afternoon
  - evening
  - all_day
```

Mapping khung giờ:

```text
morning:   07:00-11:00
noon:      11:00-13:30
afternoon: 13:30-17:30
evening:   17:30-22:00
all_day:   không phạt
```

Ví dụ:

```text
Bảo tàng -> morning / afternoon
Chợ đêm -> evening
Bãi biển -> morning / afternoon
Cafe view hoàng hôn -> afternoon
Bar/Pub -> evening
Nhà hàng -> noon / evening
Công viên giải trí -> all_day
```

## 5. Cách dùng best_time_of_day

### Option 1: Soft penalty trong GA fitness

Ví dụ:

```text
Cafe best_time = afternoon
Nếu xếp cafe lúc 16:00 -> tốt
Nếu xếp cafe lúc 08:00 -> bị phạt nhẹ
```

Ưu điểm:

- Linh hoạt, dữ liệu ít vẫn tạo được lịch trình.
- Phù hợp với du lịch thật, vì "nên đi buổi tối" không có nghĩa là "cấm đi buổi chiều".
- GA có thể tự đánh đổi route, giờ mở cửa, ranking và trải nghiệm.
- Ít làm lịch trình bị fail hoặc trống ngày.

Nhược điểm:

- Cần tune trọng số penalty.
- Nếu penalty quá nhẹ thì GA bỏ qua.
- Nếu penalty quá nặng thì gần giống hard constraint.

Đây là hướng nên dùng chính.

### Option 2: Ép open_time/close_time theo best_time_of_day

Ví dụ:

```text
Chợ đêm: ép open_time = 18:00
Cafe hoàng hôn: ép open_time = 15:00, close_time = 18:30
Bar/Pub: ép open_time = 19:00
```

Ưu điểm:

- Dễ implement.
- GA tự xử lý bằng logic giờ mở cửa sẵn có.
- Kết quả nhìn đúng thời điểm mạnh hơn.

Nhược điểm:

- Không đúng bản chất dữ liệu nếu địa điểm thật sự mở cả ngày.
- Dễ làm GA loại bỏ quá nhiều địa điểm, nhất là tỉnh ít POI.
- Có thể gây wait time lớn hoặc ngày trống.
- Khó debug vì không biết fail do giờ mở cửa thật hay rule ép.

Chỉ nên dùng cho trường hợp rất rõ:

```text
chợ đêm
bar/pub
phố đi bộ buổi tối
điểm ngắm hoàng hôn
sunrise/sunset spot
```

### Option 3: Kết hợp soft penalty + hard window cho loại đặc biệt

Đây là phương án khuyên dùng.

```text
Restaurant:
- Lunch: hard-ish window 11:30-13:30
- Dinner: soft preference 18:00-20:00

Cafe:
- Soft preference chiều/tối
- Không tính là bữa chính

Entertainment:
- Soft preference chiều/tối

Night market / bar:
- Hard window tối

Attraction / museum:
- Soft preference sáng/chiều
```

Ưu điểm:

- Thực tế nhất.
- Không làm lịch trình chết vì dữ liệu ít.
- Vẫn đảm bảo ràng buộc quan trọng như ăn trưa.
- Dễ giải thích trong báo cáo: hard constraint cho điều bắt buộc, soft constraint cho trải nghiệm tốt hơn.

Nhược điểm:

- Cần thiết kế bảng rule rõ.
- Fitness sẽ nhiều thành phần hơn, cần log để hiểu vì sao GA chọn như vậy.

## 6. Budget

Two-Tower gần như chưa hiểu "lịch trình phù hợp ngân sách".

Lý do: budget phụ thuộc vào tổ hợp cả lịch trình, không chỉ từng địa điểm riêng lẻ.

GA nên tính tổng chi phí dự kiến:

```text
tổng vé tham quan
+ ăn uống
+ khách sạn
+ di chuyển
+ số người
+ số ngày
```

Nên bổ sung các field dữ liệu:

```text
estimated_cost_min
estimated_cost_max
cost_type: free | low | medium | high | luxury
ticket_price
meal_price_avg
hotel_price_per_night
```

Fitness có thể xử lý:

```text
budget_penalty = max(0, estimated_total_cost - user_budget) * weight
```

Hoặc theo mức:

```text
Nếu budget không giới hạn -> không phạt
Nếu có budget -> ưu tiên lịch trình nằm trong budget
Nếu vượt nhẹ -> phạt nhẹ
Nếu vượt nhiều -> phạt nặng
```

## 7. Fitness GA nên hướng tới điều gì

GA không chỉ tối ưu "địa điểm hợp sở thích".

GA cần tối ưu lịch trình thật:

- Có hotel thật.
- Đúng giờ mở cửa.
- Đủ restaurant đúng giờ ăn.
- Cafe không tính là bữa chính.
- Thời gian di chuyển hợp lý.
- Số POI/ngày cân bằng.
- Thời điểm tham quan hợp lý.
- Không vượt ngân sách nếu người dùng có budget.
- Không tạo ngày trống nếu vẫn còn candidate phù hợp.

## 8. Kết luận thiết kế

Không nên nhồi `best_time_of_day` và budget vào Two-Tower chính.

Two-Tower nên tập trung vào:

```text
lọc địa điểm hợp sở thích
lọc theo thành phố
lọc theo intent
học từ lịch sử người dùng
```

MMR / top-k diversification nên đảm bảo đủ loại:

```text
hotel
restaurant
attraction
cafe
entertainment
```

GA nên xử lý ngữ cảnh thực tế của chuyến đi:

```text
giờ mở cửa
giờ ăn
best_time_of_day
hotel
travel time
budget
số ngày
số người
```

Tóm gọn:

```text
Two-Tower chọn món ngon.
GA là người xếp mâm để ăn được.
```

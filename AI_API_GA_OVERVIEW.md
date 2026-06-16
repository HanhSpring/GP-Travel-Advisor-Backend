# Tổng Quan API Service, AI Service, Two-Tower Và GA Planner

Tài liệu này dành cho người làm phần GA itinerary planner, chưa cần hiểu sâu về Two-Tower hay toàn bộ backend.

Bạn chỉ cần nhớ câu này:

```text
Two-Tower = chọn danh sách địa điểm phù hợp
GA Planner = sắp danh sách đó thành lịch trình đi được
API Service = người điều phối giữa app, database và AI Service
AI Service = nơi chạy model và thuật toán
```

---

## 1. Bức Tranh Tổng Thể

Dự án hiện có luồng chính như sau:

```text
Flutter Mobile App
        |
        v
API Service - NestJS
        |
        v
AI Service - FastAPI Python
        |
        v
Model / GA / thuật toán AI
```

Nói ngắn gọn:

```text
API Service = cổng chính của app
AI Service = nơi chạy model và thuật toán nặng
```

Flutter thường không gọi thẳng AI Service. Flutter gọi API Service, rồi API Service gọi AI Service khi cần chạy model hoặc thuật toán.

---

## 2. API Service Là Gì?

API Service nằm ở:

```text
api-service/
```

Nó viết bằng NestJS, TypeScript.

Đây là backend chính mà app Flutter gọi vào.

Ví dụ app muốn:

- đăng nhập
- đăng ký
- lấy profile
- lấy danh sách địa điểm
- lấy itinerary
- tạo itinerary
- lấy review
- quản lý user
- gọi recommendation

thì app sẽ gọi API Service.

Ví dụ:

```text
Flutter gọi:
POST http://localhost:3000/itinerary/plan
```

API Service nhận request đó, kiểm tra dữ liệu, gọi database, gọi AI Service nếu cần, rồi trả kết quả lại cho Flutter.

Bạn có thể hiểu API Service như người điều phối:

- nhận request từ app
- validate dữ liệu
- lấy dữ liệu từ Supabase
- gọi AI Service
- ghép kết quả lại
- trả response cho app

API Service không nên tự chạy thuật toán AI phức tạp.

---

## 3. AI Service Là Gì?

AI Service nằm ở:

```text
ai-service/
```

Nó viết bằng Python, FastAPI.

Đây là nơi chạy:

- Two-Tower model
- embedding model
- review classifier
- GA planner
- sau này có thể thêm SVD ranking hoặc model ML khác

Ví dụ API Service gửi sang AI Service:

```text
Hãy encode thông tin chuyến đi này thành vector
```

hoặc:

```text
Đây là 60 địa điểm, hãy sắp thành lịch trình 3 ngày
```

AI Service xử lý bằng model hoặc thuật toán rồi trả kết quả.

Bạn có thể hiểu AI Service như phòng máy AI.

---

## 4. Vì Sao Phải Tách API Service Và AI Service?

Vì hai service có nhiệm vụ khác nhau.

API Service dùng TypeScript/NestJS, hợp để làm:

- REST API chính
- auth
- role
- controller/service/module
- kết nối Supabase
- business logic
- Swagger API cho app

AI Service dùng Python/FastAPI, hợp để làm:

- TensorFlow
- PyTorch
- scikit-learn
- pandas/numpy
- thuật toán GA
- xử lý model weights
- embedding/vector

Nếu nhét model Python vào NestJS thì khó bảo trì. Nếu bắt FastAPI làm toàn bộ auth/user/order/review thì cũng rối. Vì vậy tách ra là đúng.

---

## 5. Luồng Tạo Lịch Trình Hoàn Chỉnh

Đây là luồng quan trọng nhất:

```text
1. Flutter gửi yêu cầu tạo lịch trình
        |
        v
2. API Service nhận request
        |
        v
3. API Service gọi AI Service để lấy vector Two-Tower
        |
        v
4. API Service dùng vector đó query Supabase pgvector
        |
        v
5. Supabase trả danh sách địa điểm phù hợp
        |
        v
6. API Service fetch chi tiết các địa điểm đó
        |
        v
7. API Service gửi danh sách địa điểm đầy đủ sang AI Service
        |
        v
8. AI Service chạy GA planner
        |
        v
9. AI Service trả lịch trình hoàn chỉnh
        |
        v
10. API Service trả lịch trình về Flutter
```

Nói đơn giản:

```text
Two-Tower chọn địa điểm
GA sắp địa điểm thành lịch trình
API Service đứng giữa điều phối
```

---

## 6. Two-Tower Là Gì?

Two-Tower là bộ lọc địa điểm phù hợp.

Nó không tạo lịch trình.

Input của nó là thông tin chuyến đi, ví dụ:

- user đi thành phố nào
- mục đích chuyến đi là gì
- đi mấy ngày
- user là ai

Output của nó là một vector 256 chiều.

Endpoint trong AI Service:

```text
POST /recommend/encode-query
```

Code liên quan:

```text
ai-service/app/models/two_tower.py
ai-service/app/services/recommend_service.py
ai-service/app/api/routes/recommend.py
```

Model dùng 2 file:

```text
ai-service/weights/vocab.pkl
ai-service/weights/best_model.weights.h5
```

Output của endpoint encode-query có dạng:

```json
{
  "embedding": [0.01, -0.03],
  "dim": 256
}
```

Vector này không phải lịch trình. Nó chỉ dùng để tìm địa điểm phù hợp trong database.

---

## 7. Danh Sách Địa Điểm Lấy Ở Đâu?

Sau khi có vector, API Service gọi Supabase RPC:

```text
recommend_places_by_slot
```

RPC này dùng pgvector để tìm địa điểm gần vector đó nhất.

Kết quả là danh sách candidate places:

```json
{
  "place_id": "uuid",
  "place_name": "Thác Datanla",
  "category": "attraction",
  "cosine_score": 0.82
}
```

Đây mới là danh sách địa điểm phù hợp, chưa phải lịch trình.

Code phần này nằm ở:

```text
api-service/src/modules/recommendation/recommendation.service.ts
```

Endpoint retrieval-only:

```text
POST http://localhost:3000/recommendation/candidates?top_k=100
```

---

## 8. GA Planner Là Gì?

GA Planner nhận danh sách địa điểm và sắp thành lịch trình.

GA cần dữ liệu chi tiết hơn candidate list, ví dụ:

- id
- name
- longitude
- latitude
- place_type
- open_hour hoặc open_hour_compressed
- visit_duration
- average_rating

Code lõi GA nằm ở:

```text
ai-service/app/services/itinerary/planner.py
```

Wrapper API cho GA nằm ở:

```text
ai-service/app/services/itinerary_service.py
ai-service/app/api/routes/itinerary.py
ai-service/app/schemas/itinerary.py
```

Endpoint trong AI Service:

```text
POST /itinerary/plan
```

Nó nhận input dạng:

```json
{
  "num_days": 3,
  "daily_start_time": "08:00",
  "daily_end_time": "21:00",
  "places": [
    {
      "id": "uuid",
      "name": "Thác Datanla",
      "longitude": 108.4,
      "latitude": 11.9,
      "place_type": "attraction",
      "open_hour_compressed": "...",
      "visit_duration": 90
    }
  ]
}
```

Và trả output dạng lịch trình:

```json
{
  "hotel_name": "Khách sạn Demo",
  "days": [
    {
      "day": 1,
      "schedule": [
        {
          "location_name": "Thác Datanla",
          "service_start_time": "08:30",
          "departure_time": "10:00"
        }
      ]
    }
  ]
}
```

---

## 9. API Service Gọi GA Như Thế Nào?

Route tích hợp thử hiện tại:

```text
POST /itinerary/plan
```

Code nằm ở:

```text
api-service/src/modules/itinerary/itinerary.controller.ts
api-service/src/modules/recommendation/recommendation.service.ts
api-service/src/modules/recommendation/ml-client.service.ts
```

Khi Flutter gọi:

```text
POST http://localhost:3000/itinerary/plan?top_k=60
```

API Service sẽ:

1. gọi Two-Tower để lấy vector
2. query Supabase lấy candidate places
3. fetch chi tiết places
4. gọi AI Service `/itinerary/plan`
5. trả lịch trình về app

---

## 10. Người Làm GA Cần Quan Tâm Gì?

Nếu bạn làm GA, bạn không cần sửa Two-Tower.

Bạn chủ yếu quan tâm:

```text
ai-service/app/services/itinerary/planner.py
```

Đây là lõi GA.

Bạn cũng cần hiểu wrapper:

```text
ai-service/app/services/itinerary_service.py
```

Wrapper này chuyển request API thành input cho GA, rồi chuyển output GA thành JSON trả về.

Nếu lịch trình xấu, thường chỉnh trong `planner.py`.

Các phần hay cần chỉnh:

- fitness function
- penalty đi trễ
- penalty chờ lâu
- số điểm mỗi ngày
- xử lý restaurant/lunch
- buffer thời gian di chuyển
- chọn hotel/base point
- xử lý giờ mở cửa
- xử lý địa điểm không đủ dữ liệu

---

## 11. Cách Chạy Test GA Local

Nếu chỉ muốn test GA, chưa cần Two-Tower, chưa cần Supabase:

```powershell
cd C:\Users\PC\Documents\QNHU\US\TN\Project\GP-Travel-Advisor-Backend\ai-service
python scripts\preview_itinerary_planner.py --limit 30 --days 2 --start 08:00 --end 21:00
```

Lệnh này dùng CSV local, in ra:

- danh sách địa điểm input
- lịch trình GA output

Đây là cách test tốt nhất cho người làm GA.

Nếu lịch trình local chưa ổn thì không nên test full hệ thống vội, vì khi sai sẽ khó biết lỗi do Two-Tower chọn địa điểm hay do GA sắp lịch trình.

---

## 12. Cách Chạy Full Hệ Thống

Terminal 1: chạy AI Service.

```powershell
cd C:\Users\PC\Documents\QNHU\US\TN\Project\GP-Travel-Advisor-Backend\ai-service
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Terminal 2: chạy API Service.

```powershell
cd C:\Users\PC\Documents\QNHU\US\TN\Project\GP-Travel-Advisor-Backend\api-service
npm install
npm run start:dev
```

Sau đó gọi:

```text
POST http://localhost:3000/itinerary/plan?top_k=60
```

Endpoint này chạy full luồng:

```text
Two-Tower -> Supabase pgvector -> candidate places -> fetch detail -> GA planner -> itinerary
```

---

## 13. Thứ Tự Làm Việc Khuyến Nghị

Với vai trò làm GA, nên đi theo thứ tự này:

1. Chạy `preview_itinerary_planner.py`.
2. Nhìn lịch trình in ra.
3. Ghi lại điểm chưa hợp lý.
4. Chỉnh `planner.py`.
5. Chạy lại preview.
6. Khi lịch trình local ổn, test endpoint `POST /itinerary/plan`.
7. Sau đó mới chỉnh integration với Two-Tower/Supabase nếu cần.

Thứ tự này giúp tách lỗi rõ ràng:

```text
Nếu preview local sai -> lỗi nằm ở GA hoặc dữ liệu local
Nếu preview local đúng nhưng full API sai -> lỗi có thể nằm ở Two-Tower, Supabase, hoặc phần fetch detail
```

---

## 14. Tóm Tắt Một Câu

```text
Two-Tower đưa cho GA danh sách địa điểm nên đi.
GA quyết định đi địa điểm nào trước, lúc mấy giờ, ngày nào.
API Service là cổng chính cho app.
AI Service là nơi chạy model và thuật toán.
```

# Hướng Dẫn Khởi Chạy & Kiểm Thử Hệ Thống (Run & Test Guide)

Tài liệu này hướng dẫn chi tiết cách cấu hình, khởi chạy các service và thực hiện kiểm thử độc lập (Offline) cũng như kiểm thử tích hợp (Online) cho tính năng lập lịch trình GA.

---

## 1. Yêu Cầu Cài Đặt (Prerequisites)

* **Python:** Cài đặt phiên bản Python 3.11 (Khuyến nghị).
* **Node.js:** Cài đặt Node.js phiên bản 18+ và npm.
* **Cơ sở dữ liệu:** Supabase đã chạy online (hoặc local) kèm schema `travel` hoạt động bình thường.

---

## 2. Khởi Chạy Dịch Vụ AI Service (FastAPI - Port 8000)

Dịch vụ AI chạy trên nền FastAPI, cung cấp mô hình Two-Tower và bộ xử lý GA.

### 2.1. Cấu hình biến môi trường
1. Sao chép file môi trường:
   ```powershell
   cd ./ai-service
   Copy-Item .env.example .env
   ```
2. Đảm bảo file `.env` đã có đầy đủ các đường dẫn chứa model weights của Two-Tower:
   * `TWO_TOWER_VOCAB_PATH=weights/vocab.pkl`
   * `TWO_TOWER_WEIGHTS_PATH=weights/best_model.weights.h5`

### 2.2. Tạo môi trường ảo & cài đặt dependencies
```powershell
# 1. Tạo môi trường ảo
python -m venv .venv

# 2. Kích hoạt môi trường ảo (PowerShell)
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1

# 3. Nâng cấp pip và cài đặt thư viện
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install sentence-transformers==3.0.0
```

### 2.3. Khởi động FastAPI server
```powershell
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```
* Khi server khởi động thành công, bạn sẽ thấy thông báo:
  `Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)`

---

## 3. Khởi Chạy Dịch Vụ API Service (NestJS - Port 3000)

Dịch vụ cổng chính tiếp đón Client và điều phối dữ liệu.

### 3.1. Cấu hình biến môi trường
Đảm bảo file `.env` của `api-service` đã có cổng trỏ tới AI Service:
```dotenv
AI_SERVICE_URL=http://localhost:8000
```

### 3.2. Cài đặt & khởi chạy
Mở một cửa sổ Terminal mới (không tắt cửa sổ chạy AI Service ở trên):
```powershell
cd ./api-service
npm install
npm run start:dev
```
* Server NestJS sẽ hoạt động tại địa chỉ `http://localhost:3000`.

---

## 4. Các Phương Pháp Kiểm Thử (Testing)

### 4.1. Kiểm thử GA độc lập (Offline Testing)
Nếu bạn chỉ muốn thử nghiệm, tinh chỉnh thuật toán GA hoặc hàm Fitness mà không muốn phụ thuộc vào mạng, Database Supabase hay Two-Tower, bạn có thể chạy file preview trực tiếp bằng CLI:

```powershell
cd ./ai-service
# Đảm bảo môi trường ảo .venv đã được activate
python scripts/preview_itinerary_planner.py --limit 30 --days 2 --start 08:00 --end 21:00
```

* **Tham số hỗ trợ:**
  * `--limit <số>`: Số lượng địa điểm mẫu lấy từ CSV.
  * `--days <số>`: Số ngày cần lập lịch.
  * `--start <HH:MM>`: Giờ bắt đầu ngày du lịch.
  * `--end <HH:MM>`: Giờ kết thúc ngày du lịch.
  * `--gen <số>`: Số lượng thế hệ tối đa chạy GA (mặc định 200).

---

### 4.2. Kiểm thử luồng tích hợp toàn diện (Integration Testing)
Sau khi cả API Service (NestJS) và AI Service (FastAPI) đang chạy đồng thời, bạn có thể mô phỏng một yêu cầu lập lịch trình từ Client bằng cách chạy đoạn mã sau trong **PowerShell**:

```powershell
# Bước 1: Khai báo gói dữ liệu chuyến đi
$body = @{
  userId                = "---2PmXbF47D870stH1jqA"
  tripType              = "ROUND_TRIP"
  departureLocationId   = "SGN"
  destinationLocationId = "8a10b8b8-6875-58e0-9bee-27f67e54376e" # ID Đà Nẵng
  transportMode         = "AIRPLANE"
  startDate             = "2026-06-10"
  endDate               = "2026-06-12"
  dailyStartTime        = "08:00"
  dailyEndTime          = "21:00"
  tripIntent            = "Khám phá tổng hợp"
  adultCount            = 2
  childCount            = 0
  budget                = 5000000
} | ConvertTo-Json

# Bước 2: Bắn HTTP POST gửi yêu cầu lập lịch trình
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/itinerary/plan?top_k=20" `
  -ContentType "application/json; charset=utf-8" `
  -Body $body
```

Màn hình PowerShell sẽ hiển thị lịch trình dạng cấu trúc JSON chi tiết được chia theo từng ngày do GA sắp xếp.

---

## 5. Xử Lý Sự Cố Thường Gặp (Troubleshooting)

### 5.1. FastAPI báo lỗi: `Could not import module "app.main"`
* **Nguyên nhân:** Bạn đang đứng sai thư mục chạy uvicorn.
* **Cách sửa:** Đảm bảo dấu nhắc lệnh của bạn đang ở thư mục `ai-service` trước khi gõ lệnh chạy.

### 5.2. Chạy API trả về lỗi HTTP 503 Service Unavailable
* **Nguyên nhân:** Một trong các model AI (Two-Tower hoặc BGE-M3) bị thiếu file weights hoặc load lỗi khi startup.
* **Cách sửa:** Xem lại log ở Terminal của FastAPI để xác định model nào tải thất bại. Đảm bảo file `weights/vocab.pkl` và `weights/best_model.weights.h5` nằm đúng chỗ.

### 5.3. Khoảng cách đường đi hiển thị nguồn `haversine`
* **Giải thích:** Hiện tại hệ thống đang cấu hình mặc định tắt gọi API Goong (`use_goong: false`) để tránh phụ thuộc API Key ngoài. Khoảng cách di chuyển được tự động tính theo đường chim bay.
* **Cách bật lại Goong:** Cung cấp khóa API `GOONG_API_KEY` vào file `.env` của `ai-service` và đổi cấu hình truyền sang GA thành `use_goong: true`.

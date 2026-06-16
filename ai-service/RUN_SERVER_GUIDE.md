# Hướng dẫn khởi tạo và chạy AI Service

Tài liệu này hướng dẫn cách cài đặt, khởi tạo model và chạy FastAPI server trong thư mục `ai-service`.

## 1. Tổng quan

AI Service là một FastAPI application cung cấp các API:

| Endpoint                       | Mục đích                         |
| ------------------------------ | -------------------------------- |
| `GET /health`                  | Kiểm tra server đang hoạt động   |
| `POST /embedding/`             | Tạo text embedding bằng BGE-M3   |
| `POST /recommend/encode-query` | Tạo query vector bằng Two-Tower  |
| `POST /recommend/`             | Gọi recommendation theo strategy |
| `POST /review/classify`        | Phân loại review                 |
| `POST /itinerary/plan`         | Lập lịch trình bằng thuật toán GA |
| `GET /docs`                    | Swagger UI                       |

Entry point chính xác của service là:

```text
app.main:app
```

Không dùng `main:app` hoặc chạy file `main.py` ở root vì file đó là một FastAPI application mẫu cũ, không đăng ký các route AI hiện tại.

## 2. Yêu cầu hệ thống

- Python `3.11` được khuyến nghị.
- `pip` và module `venv`.
- Khoảng trống ổ đĩa và RAM đủ cho TensorFlow, PyTorch và model Hugging Face.
- Docker Desktop nếu muốn chạy bằng Docker.
- Kết nối Internet trong lần đầu tải model `BAAI/bge-m3`.

Kiểm tra phiên bản:

```powershell
python --version
python -m pip --version
```

Tất cả lệnh bên dưới cần được chạy từ thư mục:

```powershell
cd GP-Travel-Advisor-Backend/ai-service
```

## 3. Cấu hình biến môi trường

Tạo file `.env` từ file mẫu.

### Windows PowerShell

```powershell
Copy-Item .env.example .env
```

### macOS/Linux

```bash
cp .env.example .env
```

Các biến chính:

| Biến                     | Giá trị mặc định                | Mô tả                                      |
| ------------------------ | ------------------------------- | ------------------------------------------ |
| `APP_ENV`                | `development`                   | Tên môi trường chạy                        |
| `APP_PORT`               | `8000`                          | Port mong muốn của service                 |
| `API_SERVICE_URL`        | `http://localhost:3000`         | URL của NestJS API Service                 |
| `HF_HOME`                | `.cache/huggingface`            | Thư mục cache model Hugging Face           |
| `TWO_TOWER_VOCAB_PATH`   | `weights/vocab.pkl`             | Vocabulary của Two-Tower                   |
| `TWO_TOWER_WEIGHTS_PATH` | `weights/best_model.weights.h5` | Weights của Two-Tower                      |
| `TF_ENABLE_ONEDNN_OPTS`  | `0`                             | Tắt TensorFlow oneDNN optimization nếu cần |
| `TF_CPP_MIN_LOG_LEVEL`   | `2`                             | Giảm log TensorFlow                        |

Lưu ý: `APP_PORT` là cấu hình ứng dụng, nhưng Uvicorn không tự đọc biến này khi chạy bằng CLI. Phải truyền cùng port vào lệnh `uvicorn --port`.

## 4. Chuẩn bị model weights

Service vẫn có thể khởi động khi thiếu một số model, nhưng endpoint phụ thuộc vào model đó sẽ trả về HTTP `503`.

Các file model được đặt trong thư mục `weights/`:

```text
weights/
├── vocab.pkl
├── best_model.weights.h5
├── review_classifier.pt        # Tùy chọn
├── content_based.pkl           # Tùy chọn
└── collaborative.pkl           # Tùy chọn
```

Hai file cần thiết cho endpoint `POST /recommend/encode-query`:

```text
weights/vocab.pkl
weights/best_model.weights.h5
```

Model BGE-M3 dùng cho endpoint `POST /embedding/` được tải từ Hugging Face ở lần khởi động đầu tiên và lưu vào `HF_HOME`.

## 5. Chạy server local

### 5.1. Tạo virtual environment

#### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

Nếu PowerShell chặn script activation:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

#### macOS/Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 5.2. Cài dependencies

```powershell
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

`app/api/deps.py` sử dụng package `sentence-transformers` để tải BGE-M3. Nếu package này chưa có trong môi trường hiện tại, cài thêm:

```powershell
python -m pip install sentence-transformers==3.0.0
```

Kiểm tra nhanh các package quan trọng:

```powershell
python -c "import fastapi, uvicorn, tensorflow, torch; print('Dependencies OK')"
python -c "import sentence_transformers; print('Sentence Transformers OK')"
```

### 5.3. Khởi động server development

```powershell
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

`--reload` chỉ nên dùng khi phát triển vì server sẽ tự khởi động lại khi code thay đổi.

Khi startup, FastAPI lifespan sẽ gọi `load_all_models()` và ghi log trạng thái từng model. Ví dụ:

```text
Starting AI Service - loading models...
Loaded: BGE-M3
Loaded: Two Tower (QueryTower ready for inference)
All models loaded successfully
```

Các warning về model tùy chọn bị thiếu không ngăn server chạy:

```text
Content-Based weights not found - skipping
Collaborative Filtering weights not found - skipping
Review Classifier weights not found - skipping
```

### 5.4. Khởi động server dùng auto-reload

```powershell
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## 11. Cau hinh Goong cho GA Planner

GA Planner co the dung Goong Distance Matrix de tinh thoi gian va khoang cach di chuyen that hon so voi Haversine.

Them bien sau vao file `ai-service/.env`:

```dotenv
GOONG_API_KEY=your_goong_api_key_here
```

Khi API Service goi payload sang AI Service voi:

```json
{
  "use_goong": true
}
```

AI Service se doc `GOONG_API_KEY` tu `ai-service/.env` va goi Goong. Neu key khong co hoac Goong loi, planner se fallback ve Haversine.

Trong output itinerary, kiem tra field:

```json
"travel_source": "goong"
```

Neu thay `"travel_source": "haversine"` thi nghia la request chua dung Goong hoac Goong da fallback.

Hoặc

```
uvicorn app.main:app --reload --port 8000
```

Nếu đổi port trong `.env`, ví dụ `APP_PORT=8001`, hãy chạy:

```powershell
python -m uvicorn app.main:app --host 0.0.0.0 --port 8001
```

## 6. Chạy server bằng Docker

Đảm bảo file `.env` và các file weights cần thiết đã tồn tại trước khi build.

### Chạy foreground

```powershell
docker compose up --build
```

### Chạy background

```powershell
docker compose up --build -d
```

### Xem log

```powershell
docker compose logs -f ai-service
```

### Dừng service

```powershell
docker compose down
```

Docker Compose hiện map:

```text
localhost:8000 -> container:8000
./weights      -> /app/weights
./.cache       -> /app/.cache
```

Dockerfile chạy lệnh:

```text
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Do đó, thay đổi `APP_PORT` trong `.env` không tự thay đổi port của container. Muốn đổi port public, cần sửa phần `ports` trong `docker-compose.yml`.

## 7. Kiểm tra server sau khi khởi động

Mở Swagger UI:

```text
http://localhost:8000/docs
```

Kiểm tra health endpoint:

```powershell
Invoke-RestMethod http://localhost:8000/health
```

Kết quả mong đợi:

```json
{
  "status": "ok",
  "env": "development"
}
```

Kiểm tra bằng `curl`:

```bash
curl http://localhost:8000/health
```

Kiểm tra Two-Tower query encoder:

```powershell
$body = @{
  user_id = "anonymous"
  city = "Da Nang"
  trip_intent = "explore"
  intent_vibe = "relax"
  history_types = @()
  history_vibes = @()
  history_biz = @()
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8000/recommend/encode-query `
  -ContentType "application/json" `
  -Body $body
```

Response thành công có `dim` bằng `256`. Nếu Two-Tower chưa được load, endpoint trả về `503`.

## 8. Chạy tests

Khi virtual environment đang được activate:

```powershell
python -m pytest tests -v
```

Một số test chấp nhận HTTP `503` khi model chưa được cài hoặc chưa có weights. Điều này giúp kiểm tra routing và validation ngay cả trong môi trường CI không chứa model.

## 9. Tích hợp với NestJS API Service

Khi chạy cả hai service trên máy local:

```text
NestJS API Service: http://localhost:3000
AI Service:         http://localhost:8000
```

Giữ cấu hình AI Service:

```dotenv
API_SERVICE_URL=http://localhost:3000
```

NestJS cần gọi AI Service bằng URL:

```text
http://localhost:8000
```

Nếu NestJS chạy trong một Docker container khác cùng Docker network, không dùng `localhost:8000`; dùng tên service Docker tương ứng, ví dụ `http://ai-service:8000`.

## 10. Lỗi thường gặp

### `Error loading ASGI app. Could not import module "app.main"`

Nguyên nhân thường gặp là chạy lệnh từ sai thư mục.

Kiểm tra thư mục hiện tại phải là `ai-service`, sau đó chạy lại:

```powershell
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### `ModuleNotFoundError`

Virtual environment chưa được activate hoặc dependencies chưa được cài:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

### `BGE-M3 load failed: No module named 'sentence_transformers'`

Cài package còn thiếu:

```powershell
python -m pip install sentence-transformers==3.0.0
```

### BGE-M3 không tải được

Kiểm tra kết nối Internet, quyền ghi vào thư mục `.cache/`, và dung lượng ổ đĩa. Lần khởi động đầu tiên có thể mất nhiều thời gian vì service phải tải model từ Hugging Face.

### `Two Tower vocab not found` hoặc `Two Tower weights not found`

Đảm bảo các file tồn tại đúng đường dẫn:

```text
weights/vocab.pkl
weights/best_model.weights.h5
```

Hoặc cập nhật `TWO_TOWER_VOCAB_PATH` và `TWO_TOWER_WEIGHTS_PATH` trong `.env`.

### Endpoint trả về HTTP `503`

Server đang chạy nhưng model cần cho endpoint chưa được load. Xem log startup để xác định model nào bị thiếu hoặc load thất bại.

### Port `8000` đã được sử dụng

Chạy service trên port khác:

```powershell
python -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

Sau đó cập nhật URL AI Service ở các service gọi tới nó.

### Server khởi động lại nhiều lần hoặc tốn RAM khi development

`--reload` tạo tiến trình theo dõi file và có thể khiến model được load lại. Bỏ `--reload` khi không cần sửa code liên tục:

```powershell
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

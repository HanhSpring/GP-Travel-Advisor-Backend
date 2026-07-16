# GP-Travel-Advisor — AI Service

Microservice Python (FastAPI) cung cấp khả năng AI cho hệ thống gợi ý địa điểm du lịch. NestJS backend gọi vào service này để lấy embedding, encode query người dùng, và phân loại review.

---

## Mục lục

1. [Tổng quan kiến trúc](#tổng-quan-kiến-trúc)
2. [Cấu trúc thư mục](#cấu-trúc-thư-mục)
3. [Các mô hình AI](#các-mô-hình-ai)
4. [API Endpoints](#api-endpoints)
5. [Luồng tích hợp với NestJS](#luồng-tích-hợp-với-nestjs)
6. [Cài đặt & chạy local](#cài-đặt--chạy-local)
7. [Biến môi trường](#biến-môi-trường)
8. [Deploy với Docker](#deploy-với-docker)
9. [Chạy tests](#chạy-tests)

---

## Tổng quan kiến trúc

```
NestJS API Service
       │
       │ HTTP REST
       ▼
┌─────────────────────────────────────┐
│           AI Service (FastAPI)       │
│                                     │
│  /embedding  /recommend  /review    │
│      │            │          │      │
│   BGE-M3    Two-Tower    Review     │
│  Embedder    Query       Classifier │
│             Encoder                 │
└─────────────────────────────────────┘
       │
       │ 256-dim vectors
       ▼
  Supabase pgvector
  (nearest neighbor search)
```

Service hoạt động theo mô hình **microservice**: NestJS gọi AI Service qua HTTP, AI Service trả về kết quả (embedding, vector, label), NestJS xử lý tiếp phần business logic (truy vấn pgvector, sắp xếp kết quả, trả về cho app).

---

## Cấu trúc thư mục

```
ai-service/
├── app/
│   ├── main.py                  # App factory, đăng ký router, lifecycle
│   ├── api/
│   │   ├── deps.py              # Load & cache tất cả model lúc startup
│   │   └── routes/
│   │       ├── recommend.py     # Endpoints gợi ý & encode query
│   │       ├── embedding.py     # Endpoint tạo text embedding
│   │       └── review.py        # Endpoint phân loại review
│   ├── core/
│   │   ├── config.py            # Cấu hình từ biến môi trường (pydantic-settings)
│   │   └── logger.py            # Logging tập trung
│   ├── models/
│   │   ├── two_tower.py         # Kiến trúc Two-Tower (TensorFlow)
│   │   ├── review_classifier.py # Mô hình phân loại review (PyTorch)
│   │   ├── content_based.py     # Placeholder — content-based filtering
│   │   └── collaborative.py     # Placeholder — collaborative filtering
│   ├── schemas/
│   │   ├── recommend.py         # Pydantic schemas cho /recommend
│   │   ├── embedding.py         # Pydantic schemas cho /embedding
│   │   └── review.py            # Pydantic schemas cho /review
│   └── services/
│       ├── recommend_service.py # Logic encode query Two-Tower
│       ├── embedding_service.py # Logic batch encode văn bản BGE-M3
│       └── review_service.py    # Logic phân loại review
├── tests/
│   ├── test_embedding.py
│   ├── test_recommend.py
│   └── test_review.py
├── weights/                     # Chứa file weights model (không commit lên Git)
│   └── .gitkeep
├── main.py                      # Entry point (gọi uvicorn)
├── .env                         # Biến môi trường local (không commit)
├── .env.example                 # Template .env
├── Dockerfile
├── docker-compose.yml
├── requirements.txt             # Toàn bộ dependencies
└── requirements-core.txt        # Chỉ FastAPI + uvicorn (cho môi trường nhẹ)
```

---

## Các mô hình AI

### 1. BGE-M3 — Text Embedding

| Thuộc tính | Giá trị |
|---|---|
| Model | `BAAI/bge-m3` (Hugging Face) |
| Framework | sentence-transformers |
| Output | Vector 1024 chiều |
| Ngôn ngữ | Đa ngôn ngữ (hỗ trợ tiếng Việt) |
| Dùng cho | Embed mô tả địa điểm, câu query, review |

**Cách hoạt động:** Nhận danh sách văn bản, xử lý theo batch (batch_size=32), trả về ma trận embedding. Hỗ trợ L2 normalization để dùng với cosine similarity.

---

### 2. Two-Tower — Query Encoder (Gợi ý địa điểm)

Mô hình dual-encoder để học không gian biểu diễn chung giữa người dùng và địa điểm.

```
User Context ──► QueryTower ──► 256-dim vector ──► pgvector ANN search
                                                          │
Place Features ─► CandidateTower ─► 256-dim vector ───────┘
                  (đã index sẵn)
```

#### QueryTower (chạy online — encode lúc có request)

Đầu vào:

| Input | Kiểu | Embedding dim |
|---|---|---|
| `user_id` | string | 64 |
| `current_city` | string | 16 |
| `trip_intent` | string | 16 |
| `intent_vibe` | string | 8 |
| `history_business_id` | list[str] (max 30) | avg pool → 64 |
| `history_types` | list[str] (max 30) | avg pool → 16 |
| `history_vibes` | list[str] (max 30) | avg pool → 16 |

Xử lý: Concat tất cả → Dense(256, relu) → Dropout → Dense(128, relu) → Dropout → Dense(256) → **L2 normalize**

Đầu ra: vector 256 chiều

#### CandidateTower (chạy offline — đã index vào pgvector)

Fusion 3 nhánh:
- **Gate 1 (Semantic):** BGE-M3 1024-dim → Dense(256) → Dense(128) → BatchNorm
- **Gate 2 (Categorical):** business_id + city + category + types + vibes → Dense(128) → BatchNorm
- **Gate 3 (Numerical):** [stars, log(review_count)] → Dense(32) → BatchNorm

Concat(Gate1, Gate2, Gate3) → Dense(256, relu) → Dropout → Dense(256) → **L2 normalize**

**File weights cần có:**
- `weights/vocab.pkl` — vocabulary cho tất cả các categorical feature
- `weights/best_model.weights.h5` — trọng số model (HDF5)

---

### 3. Review Classifier — Phân loại review

Phân biệt review mô tả đặc điểm **bền vững** (long-term) hay **nhất thời** (short-term) của địa điểm.

| Label | Ý nghĩa | Ví dụ |
|---|---|---|
| `long_term` | Đặc điểm ổn định, luôn đúng | "Quán này lúc nào cũng đông", "giá rất hợp lý" |
| `short_term` | Trạng thái tạm thời, có thể thay đổi | "Hôm nay đông quá", "đang có khuyến mãi" |

**Kiến trúc (PyTorch):**
```
BGE-M3(review) → 1024-dim → Linear(1024→256) → ReLU → Dropout(0.3) → Linear(256→2) → Softmax
```

**File weights cần có:** `weights/review_classifier.pt`

> **Lưu ý:** Service hiện trả về placeholder confidence=0.0 cho đến khi có file weights.

---

### 4. Content-Based & Collaborative Filtering

Hiện là **placeholder (stub)** — chưa implement. Định hướng:
- **Content-based:** Tính similarity giữa các địa điểm dựa trên đặc trưng (category, tags, mô tả)
- **Collaborative filtering:** Ma trận user-item từ lịch sử tương tác

---

## API Endpoints

### `GET /health`

Kiểm tra service còn sống.

```json
{ "status": "ok", "env": "development" }
```

---

### `POST /embedding/`

Tạo embedding vector cho danh sách văn bản.

**Request:**
```json
{
  "texts": ["Nhà thờ Đức Bà Sài Gòn", "Bãi biển Mỹ Khê Đà Nẵng"],
  "normalize": true
}
```

**Response:**
```json
{
  "embeddings": [[0.021, -0.003, ...], [0.018, 0.041, ...]],
  "model": "BAAI/bge-m3"
}
```

- Mỗi vector có 1024 chiều
- `normalize: true` → L2 normalize (dùng cho cosine similarity)

---

### `POST /recommend/encode-query`

Encode ngữ cảnh người dùng thành vector 256 chiều để tìm kiếm trên pgvector.

**Request:**
```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "city": "Đà Nẵng",
  "trip_intent": "Khám phá tổng hợp",
  "intent_vibe": "Thư giãn",
  "history_types": ["beach", "restaurant", "cafe"],
  "history_vibes": ["chill", "romantic"],
  "history_biz": ["biz_id_1", "biz_id_2"]
}
```

- `user_id`: UUID từ Supabase hoặc `"anonymous"` cho khách chưa đăng nhập
- `history_*`: Lấy từ lịch sử của người dùng, tối đa 30 phần tử mỗi list

**Response:**
```json
{
  "embedding": [0.031, -0.012, 0.089, ...],
  "dim": 256
}
```

NestJS nhận vector này và thực hiện ANN search trên pgvector của Supabase.

---

### `POST /recommend/`

Gợi ý theo chiến lược (strategy).

**Request:**
```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "top_k": 10,
  "strategy": "two_tower"
}
```

Các strategy hỗ trợ: `two_tower`, `content_based`, `cf`

> **Lưu ý:** `content_based` và `cf` hiện trả về 501 Not Implemented. Với `two_tower`, candidate retrieval được xử lý bên NestJS qua pgvector — endpoint `/encode-query` là endpoint chính nên dùng.

---

### `POST /review/classify`

Phân loại danh sách review thành `short_term` hoặc `long_term`.

**Request:**
```json
{
  "reviews": [
    "Quán rất đông vào cuối tuần",
    "Hôm nay hết món tôi hay gọi"
  ]
}
```

**Response:**
```json
{
  "results": [
    { "text": "Quán rất đông vào cuối tuần", "label": "long_term", "confidence": 0.87 },
    { "text": "Hôm nay hết món tôi hay gọi", "label": "short_term", "confidence": 0.91 }
  ]
}
```

---

## Luồng tích hợp với NestJS

### Luồng 1: Index địa điểm (chạy offline / batch)

```
Admin thêm địa điểm mới
    │
    ▼
NestJS → POST /embedding/  (gửi mô tả địa điểm)
    │
    ▼
AI Service trả về vector 1024-dim
    │
    ▼
NestJS lưu vector vào cột pgvector trên Supabase
```

### Luồng 2: Gợi ý địa điểm cho người dùng (online)

```
User mở app → chọn điểm đến, mục đích chuyến đi
    │
    ▼
NestJS thu thập user context (city, intent, history)
    │
    ▼
NestJS → POST /recommend/encode-query
    │
    ▼
AI Service → QueryTower → vector 256-dim
    │
    ▼
NestJS → pgvector ANN search (top-K địa điểm gần nhất)
    │
    ▼
NestJS xử lý business logic (filter, re-rank, format)
    │
    ▼
App nhận danh sách địa điểm gợi ý
```

### Luồng 3: Phân tích review (background job)

```
Review mới được tạo
    │
    ▼
NestJS → POST /review/classify
    │
    ▼
AI Service → short_term / long_term + confidence
    │
    ▼
NestJS lưu label vào DB → dùng cho filter/sort
```

---

## Cài đặt & chạy local

### Yêu cầu

- Python 3.11+
- (Khuyến nghị) GPU hoặc đủ RAM cho TensorFlow CPU + PyTorch

### Các bước

```bash
# 1. Tạo virtual environment
python -m venv venv

# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

# 2. Cài dependencies
pip install -r requirements.txt

# 3. Tạo file .env
cp .env.example .env
# Chỉnh sửa .env theo môi trường của bạn

# 4. Đặt file weights vào thư mục weights/
#    weights/vocab.pkl
#    weights/best_model.weights.h5
#    weights/review_classifier.pt

# 5. Chạy service
uvicorn app.main:app --reload --port 8000
```

Với pipeline ML nặng như Lọc đánh giá, không nên dùng `--reload`: tiến trình theo dõi file có thể restart worker giữa lúc model đang được khởi tạo và làm mất model cache.
Chạy service bằng lệnh sau: uvicorn app.main:app --host 127.0.0.1 --port 8000


### Quản lý bộ nhớ model nặng

- Two-Tower, Hybrid Recommender, Session-CF và itinerary vẫn được khởi tạo như trước; review-filter không thay đổi model hoặc kết quả của chúng.
- BGE-M3 chỉ phục vụ `/embedding`, không được dùng bởi luồng Two-Tower `/recommend/encode-query` hay itinerary hiện tại.
- BGE-M3 và bộ transformer review-filter được điều phối theo workload để không cùng chiếm RAM. Các request liên tiếp cùng loại vẫn dùng cache; khi đổi loại, cache model nặng của loại trước được giải phóng.
- Đặt `PRELOAD_BGE_M3=true` trên máy đủ RAM nếu cần giảm cold-start cho request `/embedding` đầu tiên. Môi trường RAM hạn chế nên giữ `false`.

Truy cập Swagger UI tại: `http://localhost:8000/docs`

---

## Biến môi trường

Tạo file `.env` từ `.env.example`:

| Biến | Mặc định | Mô tả |
|---|---|---|
| `APP_ENV` | `development` | Môi trường chạy |
| `APP_PORT` | `8000` | Port của service |
| `MODEL_WEIGHTS_DIR` | `weights` | Thư mục chứa weights |
| `API_SERVICE_URL` | `http://localhost:3000` | URL của NestJS backend |
| `HF_HOME` | `.cache/huggingface` | Cache Hugging Face models |
| `PRELOAD_BGE_M3` | `false` | `false`: lazy-load BGE-M3 khi gọi `/embedding`, giảm RAM cho review-filter; `true`: preload để giảm độ trễ embedding đầu tiên, chỉ dùng khi máy đủ RAM. |
| `PIPELINE_OUTPUT_DIR` | `./output` | Thư mục chứa output JSON của mỗi lần chạy Lọc đánh giá. |
| `PIPELINE_SAVE_JSON` | `false` | Đặt `true` để xuất các file kết quả của ba thuật toán. Cần khởi động lại AI service sau khi thay đổi. |
| `TWO_TOWER_VOCAB_PATH` | `weights/vocab.pkl` | Đường dẫn vocab Two-Tower |
| `TWO_TOWER_WEIGHTS_PATH` | `weights/best_model.weights.h5` | Đường dẫn weights Two-Tower |
| `TF_ENABLE_ONEDNN_OPTS` | `0` | Tắt TensorFlow oneDNN (tránh warning) |
| `TF_CPP_MIN_LOG_LEVEL` | `2` | Giảm log spam của TensorFlow |

---

## Deploy với Docker

```bash
# Build và chạy
docker-compose up --build

# Chạy background
docker-compose up -d
```

**Lưu ý volumes trong `docker-compose.yml`:**
- `./weights:/app/weights` — mount thư mục weights vào container
- `./.cache:/app/.cache` — cache Hugging Face models (tránh download lại)

Đảm bảo thư mục `weights/` có đủ file trước khi chạy Docker.

---

## Chạy tests

```bash
pytest tests/ -v
```

Các test được thiết kế để **tolerate** trường hợp model chưa được load (trả về 503) — phù hợp cho CI/CD khi chưa có weights. Test sẽ fail cứng nếu endpoint trả về 4xx không mong đợi.

| File test | Kiểm tra |
|---|---|
| `test_embedding.py` | POST /embedding/ với văn bản tiếng Việt |
| `test_recommend.py` | Strategy không hợp lệ → 400, strategy chưa implement → 501 |
| `test_review.py` | POST /review/classify với review tiếng Việt |

---

## Stack công nghệ

| Thành phần | Công nghệ | Version |
|---|---|---|
| Web framework | FastAPI | 0.111.0 |
| ASGI server | Uvicorn | 0.29.0 |
| Deep learning (query encoding) | TensorFlow CPU | 2.16.1 |
| Deep learning (classifier) | PyTorch | 2.3.0 |
| Pretrained models | Transformers + Sentence-Transformers | 4.41.0 / 3.0.0 |
| Validation | Pydantic v2 | 2.7.1 |
| Data processing | NumPy, Pandas, Scikit-learn | — |
| Testing | Pytest + pytest-asyncio | 8.2.0 |

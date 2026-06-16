# Two-Tower Recommendation System — Kiến trúc & Trạng thái

> Tài liệu này mô tả luồng hoàn chỉnh của hệ thống recommendation Two-Tower,
> dùng để onboard phiên làm việc mới hoặc tích hợp thêm model (VD: SVD CF Ranking).

---

## 1. Tổng quan luồng

```
Flutter App
    │  POST /recommendation/candidates?top_k=100
    │  Body: { userId, destinationLocationId, tripIntent, startDate, endDate, ... }
    ▼
NestJS API (port 3000)
    │  1. Lookup city name từ destinationLocationId → Supabase
    │  2. POST /recommend/encode-query → FastAPI
    │  3. Gọi RPC recommend_places_by_slot × N slot (song song)
    │  4. diversifyTopK → top-K candidates
    │  5. Trả response (predict_ranking = null)
    ▼
FastAPI AI Service (port 8000)
    │  QueryTower forward pass → float32[256]
    ▼
Supabase PostgreSQL (pgvector + HNSW index)
    │  Vector search trong từng slot_type
    ▼
NestJS → Flutter
```

Luồng trên là **retrieval phase**: tìm danh sách địa điểm phù hợp. Output này chưa phải lịch trình hoàn chỉnh.

Luồng tạo lịch trình đầy đủ cần tích hợp tiếp:

```
Flutter App
    │  POST /itinerary
    ▼
NestJS API
    │  1. retrieveCandidates(dto, topK)
    │  2. Lấy detail places theo candidate IDs
    │  3. Gửi places + trip config sang GA itinerary planner
    ▼
FastAPI AI Service
    │  POST /itinerary/plan
    │  app/services/itinerary_service.py
    │  app/services/itinerary/planner.py
    │  TSP-TW Genetic Algorithm
    ▼
NestJS → Flutter
    Lịch trình theo ngày/khung giờ/di chuyển
```

Ghi chú quan trọng: `TwoTowerRetrievalResponseDto.candidates[]` hiện chỉ đủ cho UI preview/ranking (`place_id`, `place_name`, `category`, `cosine_score`). Trước khi gọi GA planner cần fetch lại dữ liệu đầy đủ từ `travel.places`: `id`, `name`, `longitude`, `latitude`, `open_hour`/`open_hour_compressed`, `source`, `type_id`, `visit_duration`, `average_rating`.

---

## 2. FastAPI AI Service (`ai-service/`)

### Endpoint

```
POST /recommend/encode-query
```

### Request body (`EncodeQueryRequest`)

```json
{
  "user_id":       "string — Supabase UUID (cold-start: [UNK] trong vocab)",
  "city":          "string — tên thành phố, VD: 'Đà Lạt'",
  "trip_intent":   "string — 1 trong 6 giá trị vocab",
  "intent_vibe":   "string — để trống ''",
  "history_types": ["string"],
  "history_vibes": ["string"],
  "history_biz":   ["string"]
}
```

### Response (`EncodeQueryResponse`)

```json
{ "embedding": [float × 256], "dim": 256 }
```

### `trip_intent` — 6 giá trị hợp lệ (phải khớp vocab model)

```
'Ẩm thực & Bản địa'
'Đô thị & Vui chơi'
'Khám phá & Sinh thái'
'Khám phá tổng hợp'
'Nghỉ dưỡng & Biển'
'Văn hóa & Lịch sử'
```

### Lưu ý cold-start

Model được train với Foody/Yelp user IDs (dạng `---2PmXbF47D870stH1jqA`).
Mọi Supabase UUID thật đều OOV → token `[UNK]` → user embedding hằng số.
Chất lượng query vector phụ thuộc chủ yếu vào `city` + `trip_intent`.
Re-train với Supabase UUIDs là việc long-term, không blocking demo.

---

## 3. Supabase Schema liên quan

### Bảng `travel.places` (các cột quan trọng)

| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `name` | varchar(100) | |
| `city_id` | uuid FK → travel.cities | |
| `type_id` | uuid FK → travel.types | |
| `slot_type` | varchar(50) | **Đã populate** — xem mapping bên dưới |
| `travel_type` | varchar(100) | Training vocab value, filter attraction theo trip_intent |
| `embedding_256` | vector(256) | CandidateTower embedding, HNSW index |
| `is_active` | boolean | |
| `image_url` | text[] | |
| `address` | varchar(200) | |
| `average_rating` | numeric(3,2) | |
| `review_count` | integer | |

### Hierarchy type

```
travel.places.type_id
    → travel.types (30 loại: 'Nhà hàng', 'Cafe & Đồ uống', 'Khách sạn & Resort', ...)
        → travel.categories (7 nhóm: 'Ẩm thực', 'Lưu trú', 'Tham quan & Khám phá', ...)
```

### `slot_type` mapping

| slot_type | type names |
|-----------|-----------|
| `attraction` | Thiên nhiên, Bãi biển/Vịnh, Di tích, Bảo tàng & Không gian trưng bày, Làng nghề, Công trình tôn giáo, Nông trại, Tour có hướng dẫn |
| `restaurant` | Nhà hàng, Quán ăn, Pub/Bar, Quán chay, Buffet & Khu ẩm thực |
| `cafe` | Cafe & Đồ uống, Tiệm bánh & Tráng miệng |
| `entertainment` | Rạp phim, Karaoke, Billiards, Công viên giải trí, Bảo tàng nghệ thuật/3D, Nhà hát/Sân khấu, Thể thao trong nhà, Thể thao ngoài trời, Spa & Thư giãn, Phố đi bộ, Công viên/Quảng trường, Đài quan sát & Khu chụp ảnh |
| `accommodation` | Khách sạn & Resort, Homestay & Villa, Nhà nghỉ |
| `shopping` | Trung tâm thương mại, Chợ truyền thống, Cửa hàng đặc sản/Quà lưu niệm, Cửa hàng tiện lợi, Dịch vụ du lịch |

### RPC `recommend_places_by_slot`

```sql
travel.recommend_places_by_slot(
    query_embedding  vector(256),
    target_city_id   uuid,
    p_slot_type      varchar(50),
    p_limit          int             DEFAULT 20,
    p_travel_type    varchar(100)    DEFAULT NULL  -- chỉ filter attraction
)
RETURNS TABLE (
    place_id    uuid,
    place_name  text,
    address     text,
    image_url   text,
    category    text,   -- = slot_type
    type_name   text,
    score       float   -- cosine similarity
)
```

Cơ chế: **filter `slot_type` TRƯỚC, ANN search TRONG pool đó** — khớp với notebook `retrieve_diverse_topk`.

---

## 4. NestJS Recommendation Module

### Files

| File | Vai trò |
|------|---------|
| `src/modules/recommendation/recommendation.controller.ts` | POST /recommendation/candidates |
| `src/modules/recommendation/recommendation.service.ts` | Core pipeline |
| `src/modules/recommendation/ml-client.service.ts` | HTTP call → FastAPI |
| `src/modules/recommendation/utils/mmr-rerank.ts` | Quota, slot logic, diversifyTopK |

---

## 4.1. FastAPI Itinerary Planner Module

### Endpoint

```
POST /itinerary/plan
```

### Vai trò

Nhận danh sách địa điểm đã được retrieval và đã fetch đủ detail, sau đó chạy TSP-TW Genetic Algorithm để tạo lịch trình theo ngày/khung giờ.

### Request tối thiểu

```json
{
  "num_days": 3,
  "daily_start_time": "08:00",
  "daily_end_time": "21:00",
  "places": [
    {
      "id": "uuid",
      "name": "Tên địa điểm",
      "longitude": 106.7,
      "latitude": 10.8,
      "place_type": "attraction",
      "slot_type": "attraction",
      "source": "trip",
      "type_id": "uuid",
      "type_name": "Bảo tàng & Không gian trưng bày",
      "open_hour_compressed": "[Mon-Sun]:[08:00-22:00]",
      "visit_duration": 90,
      "average_rating": 4.5
    }
  ]
}
```

Nếu request không có `place_type=hotel`, service sẽ tạo hotel/base giả tại tâm các địa điểm candidate. Khi tích hợp thật, NestJS nên truyền `selected_hotel_id` hoặc hotel/accommodation đã chọn.

### Local preview

Chạy từ thư mục `ai-service`:

```powershell
python scripts/preview_itinerary_planner.py --city-id 3b9a22b3-293b-5313-97c5-d9b71c30756f --limit 30 --days 2 --start 08:00 --end 21:00
```

Script này dùng CSV local trong `GPTravelAdvisorDataLab/data/itinerary`, in danh sách candidate mẫu, rồi chạy GA planner bằng Haversine/cache để in lịch trình.

### Luồng `retrieveCandidates(dto, topK=100)`

```
1. getCityName(destinationLocationId)  →  "Đà Lạt"

2. mlClient.encodeQuery({
       user_id, city, trip_intent,
       intent_vibe='', history_types=[], history_vibes=[], history_biz=[]
   })  →  embedding float[256]

3. numDays = calcNumDays(startDate, endDate)

4. fetchPlan = getStratifiedFetchPlan(tripIntent, numDays)
   // VD "Khám phá & Sinh thái", 5 ngày:
   // [
   //   { slotType: 'attraction',    limit: 50, travelType: 'Khám phá & Sinh thái' },
   //   { slotType: 'restaurant',    limit: 20 },
   //   { slotType: 'accommodation', limit: 10 },
   // ]

5. Promise.all → fetchBySlot() × N slots
   → supabase.rpc('recommend_places_by_slot', ...)

6. Deduplicate theo place_id

7. diversifyTopK(pool, numDays, tripIntent, topK)
   Phase 1: fill quota per slot (max(proportional, dailyQuota × numDays))
   Phase 2: fill remaining với best-score leftovers

8. Map → CandidatePlaceDto[] với predict_ranking = null
```

### Quota mỗi ngày theo `tripIntent`

```typescript
'Khám phá tổng hợp':    { attraction:4, restaurant:2, cafe:1, entertainment:1, accommodation:1 }
'Ẩm thực & Bản địa':    { attraction:1, restaurant:4, cafe:2, entertainment:0, accommodation:1 }
'Đô thị & Vui chơi':    { attraction:2, restaurant:2, cafe:1, entertainment:3, accommodation:1 }
'Khám phá & Sinh thái': { attraction:5, restaurant:2, cafe:0, entertainment:0, accommodation:1 }
'Nghỉ dưỡng & Biển':    { attraction:3, restaurant:2, cafe:1, entertainment:1, accommodation:1 }
'Văn hóa & Lịch sử':    { attraction:5, restaurant:2, cafe:1, entertainment:1, accommodation:1 }
```

---

## 5. Response hiện tại

**`TwoTowerRetrievalResponseDto`:**

```json
{
  "destination_name": "Đà Lạt",
  "city_id": "uuid",
  "total_candidates": 87,
  "candidates": [
    {
      "place_id":        "uuid",
      "place_name":      "Thác Datanla",
      "address":         "...",
      "image_url":       "https://...",
      "category":        "attraction",
      "cosine_score":    0.812,
      "predict_ranking": null
    }
  ]
}
```

---

## 6. Tích hợp SVD CF Ranking — Hướng dẫn cho phiên làm việc mới

### Mục tiêu

Sau khi Two-Tower trả `candidates[]` (cosine_score có, predict_ranking=null),
SVD CF Ranking nhận `(user_id, [place_id])` → trả `predict_rating` cho từng place
→ re-rank → slice top-K nhỏ hơn → kết quả cá nhân hóa hơn.

### Input SVD cần

- `user_id` — Supabase UUID (lưu ý: cold-start nếu user chưa có lịch sử)
- `place_id[]` — danh sách từ Two-Tower output
- Optional: `average_rating`, `review_count` đã có sẵn trong `travel.places`

### Output SVD trả về

```json
{
  "predictions": [
    { "place_id": "uuid", "predicted_rating": 4.2 },
    { "place_id": "uuid", "predicted_rating": 3.8 }
  ]
}
```

### FastAPI endpoint cần thêm (phía SVD service)

```
POST /recommend/predict-ratings
Body:     { "user_id": "string", "place_ids": ["uuid", ...] }
Response: { "predictions": [{ "place_id": "uuid", "predicted_rating": float }] }
```

### Vị trí chèn trong NestJS

File: `src/modules/recommendation/recommendation.service.ts`

Chèn **sau bước 7 (`diversifyTopK`), trước khi map sang DTO**:

```typescript
// Bước 8 (mới): SVD CF re-ranking
const placeIds = diversePool.map(c => c.place_id);
const ratings  = await this.mlClient.predictRatings(dto.userId, placeIds);
// ratings: Map<place_id, predicted_rating>

const reranked = diversePool
  .map(c => ({ ...c, predictRanking: ratings.get(c.place_id) ?? null }))
  .sort((a, b) => (b.predictRanking ?? b.score) - (a.predictRanking ?? a.score))
  .slice(0, finalTopK);

// Bước 9: Map → DTO (thay diversePool bằng reranked)
```

### Lưu ý khi tích hợp

- **Cold-start user**: nếu SVD không có dữ liệu cho user → trả `null` → fallback dùng `cosine_score` (đã có sẵn trong sort logic trên)
- **Không block Two-Tower**: SVD là bước post-processing, Two-Tower vẫn chạy độc lập
- **`MlClientService`** (`ml-client.service.ts`) cần thêm method `predictRatings()` gọi FastAPI endpoint mới

---

## 7. Trạng thái hiện tại

| Component | Trạng thái | Ghi chú |
|-----------|-----------|---------|
| FastAPI Two-Tower encode-query | ✅ Hoạt động | weights tại `ai-service/weights/` |
| Supabase `slot_type` column | ✅ Đã populate | index `idx_places_city_slot` |
| RPC `recommend_places_by_slot` | ✅ Đã tạo | filter trước ANN |
| NestJS stratified retrieval | ✅ Hoạt động | trả đa dạng slot |
| GA itinerary planner | ✅ FastAPI route đã có `POST /itinerary/plan` | Chờ NestJS client fetch detail candidates → gọi planner |
| `predict_ranking` | ⏳ Luôn `null` | **chờ tích hợp SVD CF** |
| User history integration | ⏳ history=`[]` | chờ Phase 4 |
| Re-train với Supabase UUIDs | ⏳ Long-term | không blocking |

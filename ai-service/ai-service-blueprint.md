# AI Service — Blueprint

> Đây là file hướng dẫn để Claude Code đọc và tạo toàn bộ cấu trúc folder `ai-service`.
> Framework: **Python + FastAPI**. Kết nối với `api-service` (NestJS) qua HTTP REST.

---

## Mục tiêu

Xây dựng một microservice AI độc lập phục vụ các model:

- **Two Tower** — recommendation theo user-item embedding
- **Content-Based Filtering** — recommendation theo đặc trưng item
- **Collaborative Filtering (CF)** — recommendation theo hành vi tập thể
- **Review Classifier** — phân loại review ngắn hạn / dài hạn dựa theo ngôn ngữ
- **BGE-M3 + HuggingFace pretrained** — embedding văn bản đa ngôn ngữ

---

## Cấu trúc thư mục cần tạo

```
ai-service/
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── api/
│   │   ├── __init__.py
│   │   ├── deps.py
│   │   └── routes/
│   │       ├── __init__.py
│   │       ├── recommend.py
│   │       ├── embedding.py
│   │       └── review.py
│   ├── core/
│   │   ├── __init__.py
│   │   ├── config.py
│   │   └── logger.py
│   ├── models/
│   │   ├── __init__.py
│   │   ├── two_tower.py
│   │   ├── content_based.py
│   │   ├── collaborative.py
│   │   └── review_classifier.py
│   ├── schemas/
│   │   ├── __init__.py
│   │   ├── recommend.py
│   │   ├── embedding.py
│   │   └── review.py
│   └── services/
│       ├── __init__.py
│       ├── recommend_service.py
│       ├── embedding_service.py
│       └── review_service.py
├── weights/
│   └── .gitkeep
├── tests/
│   ├── __init__.py
│   ├── test_recommend.py
│   ├── test_embedding.py
│   └── test_review.py
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

---

## Nội dung từng file

### `requirements.txt`

```txt
fastapi==0.111.0
uvicorn[standard]==0.29.0
pydantic==2.7.1
pydantic-settings==2.2.1
python-dotenv==1.0.1
torch==2.3.0
transformers==4.41.0
sentence-transformers==3.0.0
scikit-learn==1.4.2
numpy==1.26.4
pandas==2.2.2
httpx==0.27.0
pytest==8.2.0
pytest-asyncio==0.23.6
```

---

### `.env.example`

```env
APP_ENV=development
APP_PORT=8000
MODEL_WEIGHTS_DIR=weights

# NestJS api-service (để ai-service gọi ngược lại nếu cần)
API_SERVICE_URL=http://localhost:3000

# HuggingFace cache
HF_HOME=.cache/huggingface
```

---

### `.gitignore`

```
__pycache__/
*.pyc
*.pyo
.env
venv/
.venv/
weights/*.pt
weights/*.pkl
weights/*.bin
.cache/
*.egg-info/
dist/
```

---

### `app/core/config.py`

```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_env: str = "development"
    app_port: int = 8000
    model_weights_dir: str = "weights"
    api_service_url: str = "http://localhost:3000"
    hf_home: str = ".cache/huggingface"

    class Config:
        env_file = ".env"

settings = Settings()
```

---

### `app/core/logger.py`

```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)

def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
```

---

### `app/api/deps.py`

> **Quan trọng**: Load tất cả models 1 lần duy nhất khi server khởi động.
> Lưu vào dict `_models` để tái sử dụng, tránh load lại mỗi request.

```python
from app.core.logger import get_logger

logger = get_logger(__name__)
_models: dict = {}


def load_all_models():
    """Gọi trong lifespan của FastAPI. Load toàn bộ model vào memory."""
    _load_bge_m3()
    _load_two_tower()
    _load_content_based()
    _load_collaborative()
    _load_review_classifier()
    logger.info("✅ All models loaded successfully")


def _load_bge_m3():
    try:
        from sentence_transformers import SentenceTransformer
        _models["bge_m3"] = SentenceTransformer("BAAI/bge-m3")
        logger.info("Loaded: BGE-M3")
    except Exception as e:
        logger.warning(f"BGE-M3 load failed: {e}")


def _load_two_tower():
    import os
    path = "weights/two_tower.pt"
    if os.path.exists(path):
        import torch
        from app.models.two_tower import TwoTowerModel
        model = TwoTowerModel()
        model.load_state_dict(torch.load(path, map_location="cpu"))
        model.eval()
        _models["two_tower"] = model
        logger.info("Loaded: Two Tower")
    else:
        logger.warning("Two Tower weights not found — skipping")


def _load_content_based():
    import os, pickle
    path = "weights/content_based.pkl"
    if os.path.exists(path):
        with open(path, "rb") as f:
            _models["content_based"] = pickle.load(f)
        logger.info("Loaded: Content-Based")
    else:
        logger.warning("Content-Based weights not found — skipping")


def _load_collaborative():
    import os, pickle
    path = "weights/collaborative.pkl"
    if os.path.exists(path):
        with open(path, "rb") as f:
            _models["collaborative"] = pickle.load(f)
        logger.info("Loaded: Collaborative Filtering")
    else:
        logger.warning("Collaborative Filtering weights not found — skipping")


def _load_review_classifier():
    import os
    path = "weights/review_classifier.pt"
    if os.path.exists(path):
        import torch
        from app.models.review_classifier import ReviewClassifier
        model = ReviewClassifier()
        model.load_state_dict(torch.load(path, map_location="cpu"))
        model.eval()
        _models["review_classifier"] = model
        logger.info("Loaded: Review Classifier")
    else:
        logger.warning("Review Classifier weights not found — skipping")


def get_model(name: str):
    return _models.get(name)
```

---

### `app/main.py`

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.api.deps import load_all_models
from app.api.routes import recommend, embedding, review
from app.core.config import settings
from app.core.logger import get_logger

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 Starting AI Service — loading models...")
    load_all_models()
    yield
    logger.info("🛑 AI Service shutting down")


app = FastAPI(
    title="AI Service",
    description="Recommendation & NLP microservice cho đồ án tốt nghiệp",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(recommend.router, prefix="/recommend", tags=["Recommend"])
app.include_router(embedding.router, prefix="/embedding", tags=["Embedding"])
app.include_router(review.router,    prefix="/review",    tags=["Review"])


@app.get("/health", tags=["System"])
def health_check():
    return {"status": "ok", "env": settings.app_env}
```

---

### `app/schemas/recommend.py`

```python
from pydantic import BaseModel

class RecommendRequest(BaseModel):
    user_id: str
    top_k: int = 10
    strategy: str = "two_tower"  # "two_tower" | "content_based" | "cf"

class RecommendResponse(BaseModel):
    user_id: str
    item_ids: list[str]
    scores: list[float]
    strategy: str
```

### `app/schemas/embedding.py`

```python
from pydantic import BaseModel

class EmbedRequest(BaseModel):
    texts: list[str]
    normalize: bool = True

class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
```

### `app/schemas/review.py`

```python
from pydantic import BaseModel

class ReviewClassifyRequest(BaseModel):
    reviews: list[str]

class ReviewClassifyResponse(BaseModel):
    results: list[dict]
    # mỗi dict: { "text": str, "label": "short_term" | "long_term", "confidence": float }
```

---

### `app/services/embedding_service.py`

```python
import numpy as np
from app.api.deps import get_model
from app.core.logger import get_logger

logger = get_logger(__name__)


def encode_texts(texts: list[str], normalize: bool = True) -> tuple[list[list[float]], str]:
    model = get_model("bge_m3")
    if model is None:
        raise RuntimeError("BGE-M3 model chưa được load")

    vectors = model.encode(texts, normalize_embeddings=normalize, batch_size=32)
    return vectors.tolist(), "BAAI/bge-m3"
```

---

### `app/services/recommend_service.py`

```python
from app.api.deps import get_model
from app.core.logger import get_logger

logger = get_logger(__name__)


def recommend_two_tower(user_id: str, top_k: int) -> tuple[list[str], list[float]]:
    model = get_model("two_tower")
    if model is None:
        raise RuntimeError("Two Tower model chưa được load")
    # TODO: truyền user embedding vào model, lấy top_k items
    # item_ids, scores = model.recommend(user_id, top_k)
    raise NotImplementedError("Implement sau khi có weights")


def recommend_content_based(user_id: str, top_k: int) -> tuple[list[str], list[float]]:
    model = get_model("content_based")
    if model is None:
        raise RuntimeError("Content-Based model chưa được load")
    raise NotImplementedError("Implement sau khi có weights")


def recommend_cf(user_id: str, top_k: int) -> tuple[list[str], list[float]]:
    model = get_model("collaborative")
    if model is None:
        raise RuntimeError("CF model chưa được load")
    raise NotImplementedError("Implement sau khi có weights")
```

---

### `app/services/review_service.py`

```python
import torch
from app.api.deps import get_model
from app.core.logger import get_logger

logger = get_logger(__name__)

LABELS = ["short_term", "long_term"]


def classify_reviews(reviews: list[str]) -> list[dict]:
    model = get_model("review_classifier")
    if model is None:
        raise RuntimeError("Review Classifier chưa được load")

    results = []
    # TODO: tokenize + forward pass qua model
    # Placeholder trả về dummy khi chưa có weights
    for text in reviews:
        results.append({
            "text": text,
            "label": "short_term",
            "confidence": 0.0,
        })
    return results
```

---

### `app/api/routes/embedding.py`

```python
from fastapi import APIRouter, HTTPException
from app.schemas.embedding import EmbedRequest, EmbedResponse
from app.services.embedding_service import encode_texts

router = APIRouter()


@router.post("/", response_model=EmbedResponse)
def get_embeddings(req: EmbedRequest):
    try:
        vectors, model_name = encode_texts(req.texts, req.normalize)
        return EmbedResponse(embeddings=vectors, model=model_name)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
```

---

### `app/api/routes/recommend.py`

```python
from fastapi import APIRouter, HTTPException
from app.schemas.recommend import RecommendRequest, RecommendResponse
from app.services import recommend_service

router = APIRouter()

STRATEGY_MAP = {
    "two_tower":     recommend_service.recommend_two_tower,
    "content_based": recommend_service.recommend_content_based,
    "cf":            recommend_service.recommend_cf,
}


@router.post("/", response_model=RecommendResponse)
def get_recommendations(req: RecommendRequest):
    fn = STRATEGY_MAP.get(req.strategy)
    if fn is None:
        raise HTTPException(status_code=400, detail=f"Strategy không hợp lệ: {req.strategy}")
    try:
        item_ids, scores = fn(req.user_id, req.top_k)
        return RecommendResponse(
            user_id=req.user_id,
            item_ids=item_ids,
            scores=scores,
            strategy=req.strategy,
        )
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Model chưa được implement")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
```

---

### `app/api/routes/review.py`

```python
from fastapi import APIRouter, HTTPException
from app.schemas.review import ReviewClassifyRequest, ReviewClassifyResponse
from app.services.review_service import classify_reviews

router = APIRouter()


@router.post("/classify", response_model=ReviewClassifyResponse)
def classify(req: ReviewClassifyRequest):
    try:
        results = classify_reviews(req.reviews)
        return ReviewClassifyResponse(results=results)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
```

---

### `app/models/two_tower.py`

> Skeleton — nhóm thay bằng architecture thực tế

```python
import torch
import torch.nn as nn


class TwoTowerModel(nn.Module):
    def __init__(self, user_dim: int = 64, item_dim: int = 64, embed_dim: int = 128):
        super().__init__()
        self.user_tower = nn.Sequential(
            nn.Linear(user_dim, 256),
            nn.ReLU(),
            nn.Linear(256, embed_dim),
        )
        self.item_tower = nn.Sequential(
            nn.Linear(item_dim, 256),
            nn.ReLU(),
            nn.Linear(256, embed_dim),
        )

    def forward(self, user_feat, item_feat):
        u = self.user_tower(user_feat)
        i = self.item_tower(item_feat)
        return torch.cosine_similarity(u, i, dim=-1)
```

---

### `app/models/review_classifier.py`

> Skeleton — nhóm fill vào logic phân loại ngắn hạn / dài hạn

```python
import torch
import torch.nn as nn


class ReviewClassifier(nn.Module):
    """
    Phân loại review thành ngắn hạn (short_term) hoặc dài hạn (long_term).

    Logic cốt lõi:
    - Short-term: review mô tả trạng thái tạm thời ("hôm nay đông", "đang giảm giá")
    - Long-term: review mô tả đặc trưng ổn định ("luôn đông", "giá hợp lý")

    Input: embedding vector của review text (từ BGE-M3 hoặc tương tự)
    Output: xác suất [short_term, long_term]
    """

    def __init__(self, input_dim: int = 1024, hidden_dim: int = 256):
        super().__init__()
        self.classifier = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(hidden_dim, 2),
        )

    def forward(self, x):
        return self.classifier(x)
```

---

### `Dockerfile`

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

### `docker-compose.yml`

```yaml
version: "3.9"
services:
  ai-service:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ./weights:/app/weights
      - ./.cache:/app/.cache
    env_file:
      - .env
    restart: unless-stopped
```

---

## Hướng dẫn dùng với Claude Code

Khi mở folder `ai-service` trong Claude Code, dùng prompt sau:

```
Đọc file ai-service-blueprint.md và tạo toàn bộ cấu trúc folder + file
theo đúng nội dung trong đó. Tạo đầy đủ tất cả file kể cả __init__.py
và weights/.gitkeep. Không bỏ sót file nào.
```

---

## Kiểm tra sau khi tạo xong

```bash
# 1. Tạo môi trường ảo
python -m venv venv && source venv/bin/activate

# 2. Cài dependencies
pip install -r requirements.txt

# 3. Copy file env
cp .env.example .env

# 4. Chạy server
uvicorn app.main:app --reload --port 8000

# 5. Mở Swagger để test
# http://localhost:8000/docs

# 6. Test health check
curl http://localhost:8000/health
```

---

## Kết nối từ NestJS (api-service)

```typescript
// Trong NestJS, gọi sang ai-service
const res = await this.httpService
  .post("http://localhost:8000/embedding", {
    texts: ["Hôm nay đường Nguyễn Huệ khá đông"],
    normalize: true,
  })
  .toPromise();

const res2 = await this.httpService
  .post("http://localhost:8000/recommend", {
    user_id: "u_001",
    top_k: 10,
    strategy: "two_tower",
  })
  .toPromise();
```

---

_Blueprint version 1.0 — Cập nhật khi thêm model mới hoặc thay đổi schema._

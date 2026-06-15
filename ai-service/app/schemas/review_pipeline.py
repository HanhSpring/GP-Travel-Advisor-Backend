from __future__ import annotations

from typing import List, Optional
from pydantic import BaseModel, Field


class PipelineRunRequest(BaseModel):
    limit: Optional[int] = Field(None, description="Giới hạn số review xử lý (None = tất cả pending)")
    no_pretrained: bool = Field(False, description="Bỏ qua ML models, dùng rule-based nhanh hơn")
    topic_other_threshold: float = Field(0.18, description="Ngưỡng E5 để gán topic=other")
    candidate_mode: str = Field("all", description="Chế độ chọn candidates alg2: 'all' | 'topk'")
    promotion_mode: str = Field("representative", description="Chế độ nâng cấp: 'representative' | 'all'")
    dry_run: bool = Field(False, description="Xử lý nhưng không ghi lại Supabase")


class PipelineRunResponse(BaseModel):
    success: bool
    run_id: str
    total_reviews: int
    contents_processed: int
    conflicts_detected: int
    long_term_summaries: int
    hidden_reviews: int
    output_dir: str
    started_at: str
    completed_at: str
    duration_seconds: float
    embedding_model_active: bool
    sentiment_model_active: bool
    zeroshot_model_active: bool
    phobert_model_active: bool
    error: Optional[str] = None


class PipelineHistoryItem(BaseModel):
    run_id: str
    started_at: str
    completed_at: str
    total_reviews: int
    contents_processed: int
    conflicts_detected: int
    long_term_summaries: int
    duration_seconds: float
    success: bool
    error: Optional[str] = None


class PipelineHistoryResponse(BaseModel):
    history: List[PipelineHistoryItem]
    total: int

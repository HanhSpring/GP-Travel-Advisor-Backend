from __future__ import annotations

from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class PipelineRunRequest(BaseModel):
    limit: Optional[int] = Field(None, description="Gioi han so review xu ly")
    no_pretrained: bool = Field(False, description="Bo qua ML models")
    topic_other_threshold: float = Field(0.18, description="Nguong gan topic=other")
    classifier_confidence_threshold: float = Field(0.55, description="Nguong tin cay PhoBERT")
    classifier_ambiguity_margin: float = Field(0.10, description="Bien do phan biet nhan PhoBERT")
    conflict_score_threshold: float = Field(0.65, description="Nguong xac nhan xung dot")
    candidate_mode: str = Field("all", description="'all' | 'topk'")
    top_k: int = Field(5, description="So candidate toi da khi candidate_mode='topk'")
    promotion_mode: str = Field("representative", description="'representative' | 'all'")
    ttl_hours_by_topic: Optional[Dict[str, int]] = None
    lookback_multiplier_by_topic: Optional[Dict[str, int]] = None
    observation_rules: Optional[Dict[str, Dict[str, float]]] = None
    dry_run: bool = Field(False, description="Xu ly nhung khong ghi Supabase")


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

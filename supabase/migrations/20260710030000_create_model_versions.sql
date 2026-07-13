CREATE TYPE ai_config.model_version_status_enum AS ENUM (
  'candidate', 'active', 'archived', 'failed'
);

CREATE TABLE ai_config.model_versions (
  id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
  algorithm_id uuid NOT NULL,
  version_tag character varying(100) NOT NULL,      -- vd run_id notebook, hoặc EXPERIMENT_TAG
  status ai_config.model_version_status_enum DEFAULT 'candidate' NOT NULL,
  training_dataset_id uuid,                          -- FK -> training_datasets, snapshot đã dùng để train ra version này
  weights_r2_key text,                               -- vd two-tower/versions/{run_id}/best_model.weights.h5
  vocab_r2_key text,                                 -- vd two-tower/versions/{run_id}/vocab.pkl
  artifact_r2_prefix text,                           -- dùng cho hybrid_recommender (nhiều file/prefix thay vì 2 file)
  metrics jsonb,                                     -- {"recall_at_100": 0.497, "hit_rate_at_100": 0.5425, "map_at_100": 0.0899, ...}
  trained_at timestamp without time zone,
  promoted_at timestamp without time zone,
  promoted_by uuid,                                  -- FK -> public.users
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT model_versions_pkey PRIMARY KEY (id),
  CONSTRAINT model_versions_algorithm_id_fkey
    FOREIGN KEY (algorithm_id) REFERENCES ai_config.algorithms(id) ON DELETE CASCADE,
  CONSTRAINT model_versions_training_dataset_id_fkey
    FOREIGN KEY (training_dataset_id) REFERENCES ai_config.training_datasets(id) ON DELETE SET NULL,
  CONSTRAINT model_versions_promoted_by_fkey
    FOREIGN KEY (promoted_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT model_versions_algorithm_id_version_tag_key UNIQUE (algorithm_id, version_tag)
);

ALTER TABLE ai_config.model_versions ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_model_versions_algorithm_id ON ai_config.model_versions (algorithm_id);
CREATE INDEX idx_model_versions_status ON ai_config.model_versions (algorithm_id, status);

-- Chỉ cho phép 1 version "active" tại 1 thời điểm cho mỗi thuật toán
CREATE UNIQUE INDEX uq_model_versions_one_active_per_algorithm
  ON ai_config.model_versions (algorithm_id)
  WHERE status = 'active';

GRANT ALL ON ai_config.model_versions TO anon;
GRANT ALL ON ai_config.model_versions TO authenticated;
GRANT ALL ON ai_config.model_versions TO service_role;

COMMENT ON TABLE ai_config.model_versions IS
  'Versioning cho artifact model đã train (two-tower weights, hybrid recommender artifacts). Trước đây KHÔNG tồn tại — mỗi lần train mới chỉ ghi đè file cũ, không rollback được.';
COMMENT ON COLUMN ai_config.model_versions.metrics IS
  'Chỉ số eval của lần train này (Recall@K, HitRate@K, MAP@K, RMSE...) — admin xem trước khi quyết định promote.';

CREATE TYPE ai_config.training_run_type_enum AS ENUM (
  'data_export', 'training', 'promotion'
);

CREATE TYPE ai_config.training_run_status_enum AS ENUM (
  'pending', 'running', 'completed', 'failed', 'cancelled'
);

CREATE TYPE ai_config.training_trigger_type_enum AS ENUM (
  'manual', 'schedule'
);

CREATE TABLE ai_config.training_runs (
  id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
  algorithm_id uuid NOT NULL,
  run_type ai_config.training_run_type_enum NOT NULL,
  status ai_config.training_run_status_enum DEFAULT 'pending' NOT NULL,
  trigger_type ai_config.training_trigger_type_enum DEFAULT 'manual' NOT NULL,
  triggered_by uuid,                                 -- FK -> public.users, null nếu trigger_type=schedule
  training_dataset_id uuid,                          -- FK -> training_datasets (khi run_type=data_export, chính nó tạo ra)
  model_version_id uuid,                             -- FK -> model_versions (khi run_type=training, kết quả tạo ra)
  started_at timestamp without time zone,
  completed_at timestamp without time zone,
  duration_seconds integer,
  error_message text,
  metrics jsonb,
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT training_runs_pkey PRIMARY KEY (id),
  CONSTRAINT training_runs_algorithm_id_fkey
    FOREIGN KEY (algorithm_id) REFERENCES ai_config.algorithms(id) ON DELETE CASCADE,
  CONSTRAINT training_runs_triggered_by_fkey
    FOREIGN KEY (triggered_by) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT training_runs_training_dataset_id_fkey
    FOREIGN KEY (training_dataset_id) REFERENCES ai_config.training_datasets(id) ON DELETE SET NULL,
  CONSTRAINT training_runs_model_version_id_fkey
    FOREIGN KEY (model_version_id) REFERENCES ai_config.model_versions(id) ON DELETE SET NULL
);

ALTER TABLE ai_config.training_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_training_runs_algorithm_id ON ai_config.training_runs (algorithm_id, created_at DESC);

-- Chỉ cho phép 1 run đang pending/running tại 1 thời điểm cho mỗi thuật toán
-- (tương đương flag isRunning của ReviewFilterScheduleCron, nhưng ở mức DB thay vì in-memory,
--  nên chịu được trường hợp có nhiều instance backend chạy song song)
CREATE UNIQUE INDEX uq_training_runs_one_active_per_algorithm
  ON ai_config.training_runs (algorithm_id)
  WHERE status IN ('pending', 'running');

GRANT ALL ON ai_config.training_runs TO anon;
GRANT ALL ON ai_config.training_runs TO authenticated;
GRANT ALL ON ai_config.training_runs TO service_role;

COMMENT ON TABLE ai_config.training_runs IS
  'Lịch sử job của pipeline retrain (chuẩn bị dữ liệu / train / promote), cột kiểu rõ ràng thay vì JSON text tự do như ai_config.algorithm_logs.';

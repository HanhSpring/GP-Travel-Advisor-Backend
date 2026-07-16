CREATE TYPE ai_config.training_dataset_status_enum AS ENUM (
  'preparing', 'ready', 'failed'
);

CREATE TABLE ai_config.training_datasets (
  id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
  algorithm_id uuid NOT NULL,
  status ai_config.training_dataset_status_enum DEFAULT 'preparing' NOT NULL,
  r2_prefix text NOT NULL,                    -- vd training-datasets/two_tower/{run_id}/
  row_counts jsonb,                           -- {"users": 1234, "places": 5678, "interactions": 90123}
  date_range_start timestamp without time zone,
  date_range_end timestamp without time zone,
  source character varying(50) DEFAULT 'supabase_export' NOT NULL,
  error_message text,
  created_by uuid,                            -- FK -> public.users, admin đã bấm "chuẩn bị dữ liệu"
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamp without time zone,
  CONSTRAINT training_datasets_pkey PRIMARY KEY (id),
  CONSTRAINT training_datasets_algorithm_id_fkey
    FOREIGN KEY (algorithm_id) REFERENCES ai_config.algorithms(id) ON DELETE CASCADE,
  CONSTRAINT training_datasets_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE ai_config.training_datasets ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_training_datasets_algorithm_id ON ai_config.training_datasets (algorithm_id);
CREATE INDEX idx_training_datasets_created_at ON ai_config.training_datasets (created_at DESC);

GRANT ALL ON ai_config.training_datasets TO anon;
GRANT ALL ON ai_config.training_datasets TO authenticated;
GRANT ALL ON ai_config.training_datasets TO service_role;

COMMENT ON TABLE ai_config.training_datasets IS
  'Mỗi row = 1 lần export dữ liệu Supabase ra JSONL/CSV để train lại model (Phase 0/1 của tính năng trigger retrain).';
COMMENT ON COLUMN ai_config.training_datasets.r2_prefix IS
  'Prefix trên Cloudflare R2 chứa các file dataset đã export (không phải public URL).';

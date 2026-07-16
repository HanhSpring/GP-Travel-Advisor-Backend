-- ============================================================================
-- ai_config schema — cấu hình thuật toán gợi ý (điều chỉnh trọng số runtime)
-- Dùng cho tính năng: chỉnh "hệ số khoảng cách" (distance_weight) của
-- Hybrid Recommender. Quy ước: model_weight = 1 - distance_weight, nên chỉ
-- cần lưu duy nhất distance_weight.
--
-- LƯU Ý QUAN TRỌNG (Supabase): sau khi chạy file này phải EXPOSE schema:
--   Dashboard → Project Settings → API → "Exposed schemas" → thêm `ai_config`
-- (nếu không PostgREST/ai-service sẽ báo schema không tồn tại).
-- ============================================================================

create schema if not exists ai_config;

-- ---------------------------------------------------------------- algorithms
create table if not exists ai_config.algorithms (
    id          bigint generated always as identity primary key,
    name        text not null unique,
    description text,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now()
);

-- ------------------------------------------------------- algorithm_parameters
create table if not exists ai_config.algorithm_parameters (
    id             bigint generated always as identity primary key,
    algorithm_id   bigint not null references ai_config.algorithms(id) on delete cascade,
    parameter_name text not null,
    default_value  numeric not null,
    current_value  numeric not null,
    min_value      numeric default 0,
    max_value      numeric default 1,
    updated_at     timestamptz not null default now(),
    unique (algorithm_id, parameter_name)
);

-- ------------------------------------------------------------- algorithm_logs
create table if not exists ai_config.algorithm_logs (
    id           bigint generated always as identity primary key,
    algorithm_id bigint references ai_config.algorithms(id) on delete set null,
    status       text not null,                 -- 'success' | 'error'
    action       text not null,                 -- mô tả hành động đã thực hiện
    created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------- seed data
insert into ai_config.algorithms (name, description, is_active)
values (
    'hybrid_recommender',
    'Hybrid CB + Funk-SVD CF + khoảng cách cho mục "Có thể bạn sẽ thích"',
    true
)
on conflict (name) do nothing;

insert into ai_config.algorithm_parameters
    (algorithm_id, parameter_name, default_value, current_value, min_value, max_value)
select a.id, 'distance_weight', 0.25, 0.25, 0, 1
from ai_config.algorithms a
where a.name = 'hybrid_recommender'
on conflict (algorithm_id, parameter_name) do nothing;

-- -------------------------------------------------------------------- grants
-- service_role (ai-service dùng key này) cần đủ quyền; bypass RLS sẵn.
grant usage on schema ai_config to anon, authenticated, service_role;
grant all on all tables in schema ai_config to anon, authenticated, service_role;
alter default privileges in schema ai_config
    grant all on tables to anon, authenticated, service_role;

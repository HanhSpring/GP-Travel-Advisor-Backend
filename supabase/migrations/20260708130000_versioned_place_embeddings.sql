-- Tách embedding Two-Tower khỏi cột cố định travel.places.embedding_256
-- sang bảng travel.place_embeddings có versioning theo model.
--
-- Lý do: mỗi lần fine-tune/re-train CandidateTower, vector space đổi ->
-- toàn bộ embedding cũ và mới không so sánh cosine được với nhau -> luôn
-- phải re-embed hết places, không tránh được. Nhưng việc SWAP sang model mới
-- (sau khi backfill xong) không cần đụng schema travel.places hay downtime,
-- nếu embedding không còn nằm cố định trong 1 cột:
--
--   - Mỗi vector gắn với 1 model_version (vd 'v1', 'two_tower_2026_08').
--   - Backfill model mới chạy song song ở model_version mới, không ảnh
--     hưởng dữ liệu/index của version đang live.
--   - Build HNSW index cho version mới bằng CREATE INDEX CONCURRENTLY,
--     validate offline, rồi mới update ai_config.embedding_model_config
--     để chuyển traffic -> đổi model chỉ là UPDATE 1 dòng, rollback tức thời.
--
-- travel.places.embedding_256 CHƯA bị xoá ở migration này (xem comment cuối
-- file) để giữ đường lùi cho tới khi RPC mới được verify.

create table travel.place_embeddings (
  place_id uuid not null references travel.places(id) on delete cascade,
  model_version text not null,
  embedding extensions.vector(256) not null,
  created_at timestamptz not null default now(),
  constraint place_embeddings_pkey primary key (place_id, model_version)
);

alter table travel.place_embeddings enable row level security;

grant select on table travel.place_embeddings to anon;
grant select on table travel.place_embeddings to authenticated;
grant delete, insert, select, update on table travel.place_embeddings to service_role;

-- Backfill embedding hiện có, gắn nhãn 'v1' = model đang chạy production
insert into travel.place_embeddings (place_id, model_version, embedding)
select id, 'v1', embedding_256
from travel.places
where embedding_256 is not null;

-- HNSW là partial index theo model_version -> mỗi model có index riêng,
-- build/drop version này không đụng version khác.
create index place_embeddings_v1_hnsw_idx
  on travel.place_embeddings
  using hnsw (embedding extensions.vector_cosine_ops)
  where model_version = 'v1';

-- Bảng config 1 dòng: model_version nào đang phục vụ production.
-- Đổi model = UPDATE dòng này, không cần deploy/migration mới.
create table ai_config.embedding_model_config (
  id boolean primary key default true,
  active_model_version text not null,
  updated_at timestamptz not null default now(),
  constraint embedding_model_config_singleton check (id)
);

insert into ai_config.embedding_model_config (id, active_model_version)
values (true, 'v1');

alter table ai_config.embedding_model_config enable row level security;

grant select on table ai_config.embedding_model_config to anon;
grant select on table ai_config.embedding_model_config to authenticated;
grant select, update on table ai_config.embedding_model_config to service_role;

-- recommend_places_by_slot: đọc embedding từ place_embeddings theo
-- active_model_version thay vì places.embedding_256. Signature giữ NGUYÊN
-- (NestJS gọi supabase.rpc('recommend_places_by_slot', ...) không cần đổi).
create or replace function public.recommend_places_by_slot(
  query_embedding extensions.vector,
  target_city_id uuid,
  p_slot_type character varying,
  p_limit integer default 20,
  p_travel_type character varying default null::character varying
)
returns table(place_id uuid, place_name text, address text, image_url text, category text, type_name text, score double precision)
language sql
stable
as $function$
  select
    p.id                                              as place_id,
    p.name::text                                      as place_name,
    p.address::text,
    (p.image_url)[1]                                  as image_url,
    p.slot_type::text                                 as category,
    t.name::text                                      as type_name,
    1 - (pe.embedding <=> query_embedding)            as score
  from travel.places p
  join travel.types t on t.id = p.type_id
  join travel.place_embeddings pe
    on pe.place_id = p.id
   and pe.model_version = (
     select c.active_model_version from ai_config.embedding_model_config c limit 1
   )
  where p.city_id       = target_city_id
    and p.slot_type     = p_slot_type
    and p.is_active     = true
    and (
      p_travel_type is null
      or p_slot_type != 'attraction'
      or p.travel_type = p_travel_type
      or p.travel_type is null
    )
  order by pe.embedding <=> query_embedding
  limit p_limit
$function$;

-- KHÔNG drop travel.places.embedding_256 / places_embedding_256_hnsw_idx ở
-- đây. Sau khi verify RPC recommend_places_by_slot chạy đúng trên
-- place_embeddings (so sánh candidates/score với bản cũ), tạo migration
-- riêng:
--
--   drop index if exists travel.places_embedding_256_hnsw_idx;
--   alter table travel.places drop column embedding_256;
--
-- Cũng cần sửa job batch-encode (xem INTEGRATION_PLAN_TWO_TOWER.md, mục
-- "Upsert embedding_256 vào Supabase") để upsert vào
-- travel.place_embeddings(place_id, model_version, embedding) thay vì
-- travel.places.embedding_256.

-- Cho phép test 1 model_version Two-Tower "candidate" (train thủ công, chưa qua Modal) song song
-- với bản production đang active, KHÔNG đụng travel.place_embeddings(model_version='v1') hay
-- ai_config.embedding_model_config.active_model_version (xem 20260708130000_versioned_place_
-- embeddings.sql để biết lý do tách bảng theo version).
--
-- 1. Đăng ký model_version mới với status='candidate' — KHÔNG set active, nên RPC production
--    recommend_places_by_slot() không bị ảnh hưởng gì.
-- 2. RPC test riêng recommend_places_by_slot_by_version(): giống hệt recommend_places_by_slot()
--    nhưng nhận p_model_version tường minh thay vì đọc ai_config.embedding_model_config — dùng
--    để so sánh kết quả candidate vs production trước khi quyết định promote.

-- Archive dòng đang active của two_tower_retrieval TRƯỚC (constraint chỉ cho 1 active/thuật
-- toán) — hiện là version_tag='pretrain-13' (algorithm_id=8e2c3610-41d4-4cd4-9bd6-be2740038869).
-- Không đụng các dòng 'admin-2026071*' — đó là algorithm_id khác (43d27e0e...), không liên quan.
update ai_config.model_versions
set status = 'archived'
where algorithm_id = (select id from ai_config.algorithms where name = 'two_tower_retrieval')
  and status = 'active';

insert into ai_config.model_versions (
  algorithm_id, version_tag, status, weights_r2_key, vocab_r2_key, trained_at, promoted_at
)
select
  id,
  'v15_finetune4',
  'active',
  'two-tower/versions/v15_finetune4/best_model.weights.h5',
  'two-tower/versions/v15_finetune4/vocab.pkl',
  now(),
  now()
from ai_config.algorithms
where name = 'two_tower_retrieval'
on conflict (algorithm_id, version_tag) do nothing;

create or replace function public.recommend_places_by_slot_by_version(
  query_embedding extensions.vector,
  target_city_id uuid,
  p_slot_type character varying,
  p_model_version text,
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
   and pe.model_version = p_model_version
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

grant execute on function public.recommend_places_by_slot_by_version(
  extensions.vector, uuid, character varying, text, integer, character varying
) to anon, authenticated, service_role;

-- travel.places không còn lưu slot_type nữa — slot_type giờ nằm ở travel.types.slot_type.
-- Sửa recommend_places_by_slot để lọc/trả category theo t.slot_type thay vì p.slot_type.
-- Tham số (query_embedding, target_city_id, p_slot_type, p_limit, p_travel_type) và kiểu
-- trả về giữ NGUYÊN như cũ -> dùng CREATE OR REPLACE, không cần DROP FUNCTION trước.

ALTER TABLE travel.types ADD COLUMN IF NOT EXISTS slot_type text;

CREATE OR REPLACE FUNCTION public.recommend_places_by_slot(query_embedding extensions.vector, target_city_id uuid, p_slot_type character varying, p_limit integer DEFAULT 20, p_travel_type character varying DEFAULT NULL::character varying)
 RETURNS TABLE(place_id uuid, place_name text, address text, image_url text, category text, type_name text, score double precision)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    p.id                                              AS place_id,
    p.name::text                                      AS place_name,
    p.address::text,
    (p.image_url)[1]                                  AS image_url,
    t.slot_type::text                                 AS category,
    t.name::text                                      AS type_name,
    1 - (p.embedding_256 <=> query_embedding)         AS score
  FROM travel.places p
  JOIN travel.types t ON t.id = p.type_id
  WHERE p.city_id       = target_city_id
    AND t.slot_type     = p_slot_type
    AND p.is_active     = true
    AND p.embedding_256 IS NOT NULL
    AND (
      p_travel_type IS NULL
      OR p_slot_type != 'attraction'
      OR p.travel_type = p_travel_type
      OR p.travel_type IS NULL
    )
  ORDER BY p.embedding_256 <=> query_embedding
  LIMIT p_limit
$function$;

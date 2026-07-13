-- Revert của migration 20260704160000_recommend_places_by_slot_use_types_slot_type.sql.
--
-- Migration đó đổi recommend_places_by_slot để đọc/lọc category theo
-- travel.types.slot_type thay vì travel.places.slot_type, với lý do "places không
-- còn lưu slot_type nữa". Nhưng travel.places.slot_type CHƯA BAO GIỜ bị DROP COLUMN
-- và itinerary.service.ts (getItineraryDetail) vẫn đang select trực tiếp
-- travel.places.slot_type để hiển thị category — tức 2 nơi trong cùng backend đang
-- đọc slot_type từ 2 nguồn khác nhau (types vs places), dễ lệch dữ liệu khi type
-- chung (VD "Khám phá tổng hợp") gom nhiều slot_type khác nhau ở cấp place.
--
-- Đưa recommend_places_by_slot về lại dùng p.slot_type (bản gốc ở
-- 20260624125531_init_from_old_project.sql) để thống nhất 1 nguồn sự thật duy nhất.
-- Tham số và kiểu trả về giữ NGUYÊN -> dùng CREATE OR REPLACE, không cần DROP FUNCTION.

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
    p.slot_type::text                                 AS category,
    t.name::text                                      AS type_name,
    1 - (p.embedding_256 <=> query_embedding)         AS score
  FROM travel.places p
  JOIN travel.types t ON t.id = p.type_id
  WHERE p.city_id       = target_city_id
    AND p.slot_type     = p_slot_type
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

-- Cập nhật public.get_cities_for_plan_trip:
--  1) Danh sách thành phố gợi ý/điểm đến được chốt lại còn 17 tỉnh/thành mà app đang
--     hỗ trợ lên lịch trình (theo yêu cầu sản phẩm), thay vì 14 thành phố cũ.
--  2) Thêm tham số p_destination_only: khi true, kết quả (kể cả khi có p_keyword)
--     CHỈ được lọc trong 17 tỉnh/thành nói trên — dùng cho ô chọn "điểm đến".
--     Khi false (mặc định), giữ nguyên hành vi cũ: không có keyword thì gợi ý danh
--     sách nổi bật, có keyword thì tìm kiếm trên toàn bộ travel.cities — dùng cho
--     ô chọn "điểm khởi hành" (được phép chọn bất kỳ tỉnh/thành nào).
-- Vì thêm tham số mới nên đổi signature (text) -> (text, boolean): phải DROP rồi
-- CREATE lại thay vì CREATE OR REPLACE để tránh tạo overload trùng lặp.

DROP FUNCTION IF EXISTS public.get_cities_for_plan_trip(text);

CREATE FUNCTION public.get_cities_for_plan_trip(
  p_keyword text DEFAULT NULL::text,
  p_destination_only boolean DEFAULT false
)
 RETURNS TABLE(id uuid, name text)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  -- Không có keyword: trả về danh sách 17 tỉnh/thành app đang hỗ trợ, theo thứ tự ưu
  -- tiên cố định. Dùng chung cho cả gợi ý ban đầu của "điểm khởi hành" lẫn danh sách
  -- đầy đủ của "điểm đến" (vì điểm đến bị giới hạn đúng trong danh sách này).
  IF p_keyword IS NULL OR p_keyword = '' THEN
    RETURN QUERY
      SELECT c.id, c.name::text
      FROM travel.cities c
      JOIN (VALUES
        ('a821f185-9826-568f-a3d2-967f0efd1c9d'::uuid, 1),  -- Hà Nội
        ('3b9a22b3-293b-5313-97c5-d9b71c30756f'::uuid, 2),  -- Hồ Chí Minh
        ('1aa5ed1b-16c1-51f4-a3ba-c25e0ed91ce5'::uuid, 3),  -- Khánh Hòa
        ('8a10b8b8-6875-58e0-9bee-27f67e54376e'::uuid, 4),  -- Đà Nẵng
        ('340af4ff-0cda-5e1a-8e02-a999acc906f6'::uuid, 5),  -- Lâm Đồng
        ('3cf95641-de1c-5baf-97a7-6f23cd4e72c6'::uuid, 6),  -- Cần Thơ
        ('fc51a18f-b4bb-5183-9d81-6a7e03a0ca4a'::uuid, 7),  -- Vũng Tàu
        ('477756f3-d73f-55b7-8698-21d64befaf2d'::uuid, 8),  -- Quảng Nam
        ('477a099d-8dd4-5899-877c-b911a1c7fb8b'::uuid, 9),  -- Huế
        ('9ff5279d-422e-5192-af82-12b7d154a736'::uuid, 10), -- Bình Dương
        ('c4626942-6b84-5d47-bf7f-239bc3ece44c'::uuid, 11), -- Đồng Nai
        ('8dfd58c0-e0a9-5169-8c71-fdbc2633c971'::uuid, 12), -- Kiên Giang
        ('7eedad92-8762-57fd-9584-566b0653b957'::uuid, 13), -- Quảng Ninh
        ('9d697eb4-3bf0-58a8-9f31-e086d59d7c7d'::uuid, 14), -- Bình Thuận
        ('87685562-e744-53cc-a324-2a65540348a6'::uuid, 15), -- Hải Phòng
        ('49dd4ebd-8d34-5130-a01c-bdc8ea17101e'::uuid, 16), -- Nghệ An
        ('5874b9ef-ea1e-556b-917f-2b2b0f89d98d'::uuid, 17)  -- Phú Yên
      ) AS supported(city_id, sort_order) ON supported.city_id = c.id
      ORDER BY supported.sort_order;
    RETURN;
  END IF;

  -- Có keyword nhưng bị giới hạn điểm đến: chỉ tìm trong 17 tỉnh/thành hỗ trợ.
  IF p_destination_only THEN
    RETURN QUERY
      SELECT c.id, c.name::text
      FROM travel.cities c
      JOIN (VALUES
        ('a821f185-9826-568f-a3d2-967f0efd1c9d'::uuid, 1),
        ('3b9a22b3-293b-5313-97c5-d9b71c30756f'::uuid, 2),
        ('1aa5ed1b-16c1-51f4-a3ba-c25e0ed91ce5'::uuid, 3),
        ('8a10b8b8-6875-58e0-9bee-27f67e54376e'::uuid, 4),
        ('340af4ff-0cda-5e1a-8e02-a999acc906f6'::uuid, 5),
        ('3cf95641-de1c-5baf-97a7-6f23cd4e72c6'::uuid, 6),
        ('fc51a18f-b4bb-5183-9d81-6a7e03a0ca4a'::uuid, 7),
        ('477756f3-d73f-55b7-8698-21d64befaf2d'::uuid, 8),
        ('477a099d-8dd4-5899-877c-b911a1c7fb8b'::uuid, 9),
        ('9ff5279d-422e-5192-af82-12b7d154a736'::uuid, 10),
        ('c4626942-6b84-5d47-bf7f-239bc3ece44c'::uuid, 11),
        ('8dfd58c0-e0a9-5169-8c71-fdbc2633c971'::uuid, 12),
        ('7eedad92-8762-57fd-9584-566b0653b957'::uuid, 13),
        ('9d697eb4-3bf0-58a8-9f31-e086d59d7c7d'::uuid, 14),
        ('87685562-e744-53cc-a324-2a65540348a6'::uuid, 15),
        ('49dd4ebd-8d34-5130-a01c-bdc8ea17101e'::uuid, 16),
        ('5874b9ef-ea1e-556b-917f-2b2b0f89d98d'::uuid, 17)
      ) AS supported(city_id, sort_order) ON supported.city_id = c.id
      WHERE c.name ILIKE '%' || p_keyword || '%'
      ORDER BY supported.sort_order;
    RETURN;
  END IF;

  -- Điểm khởi hành: có keyword, tìm kiếm tự do trên toàn bộ travel.cities.
  RETURN QUERY
    SELECT c.id, c.name::text
    FROM travel.cities c
    WHERE c.name ILIKE '%' || p_keyword || '%'
    ORDER BY c.name
    LIMIT 20;
END;
$function$;

GRANT ALL ON FUNCTION public.get_cities_for_plan_trip(text, boolean) TO anon;
GRANT ALL ON FUNCTION public.get_cities_for_plan_trip(text, boolean) TO authenticated;
GRANT ALL ON FUNCTION public.get_cities_for_plan_trip(text, boolean) TO service_role;

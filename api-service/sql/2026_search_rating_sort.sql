-- =============================================================================
-- Search Rating Sort — nâng cấp điểm xếp hạng của travel.search_autocomplete
-- =============================================================================
-- Mục tiêu: kết quả search mặc định sort theo địa điểm có RATING CAO NHẤT và
-- SỐ LƯỢT ĐÁNH GIÁ NHIỀU NHẤT (trước đây score chỉ dựa vào average_rating,
-- nên 5.0★ với 1 review xếp trên 4.7★ với 500 review).
--
-- Công thức: Bayesian weighted rating (kiểu IMDb), đồng bộ với
-- SearchService.weightedRank() phía backend:
--   bayes = (v / (v + m)) * R  +  (m / (v + m)) * C
--   trong đó R = average_rating, v = review_count, m = 10, C = 3.0
--   (v = 0 và R = 0 → bayes = 0: chưa có dữ liệu thì xếp cuối)
--
-- score PLACE = prefix_boost (3 nếu tên bắt đầu bằng query) + bayes / 5 (0..1)
-- score CITY  = 100 (prefix) / 50 (infix) → city luôn nổi trên cùng.
--
-- Yêu cầu: đã chạy 2026_search_optimization.sql trước (immutable_unaccent + index).
-- Cách chạy: Supabase Dashboard -> SQL Editor -> dán toàn bộ file -> Run.
-- Script idempotent: chạy lại nhiều lần không gây lỗi.
-- =============================================================================

-- Index hỗ trợ các truy vấn top-N sort theo rating + review_count
-- (dùng cho fallback prefix của backend; sort 2000 dòng sau lọc trigram thì
--  Postgres tự sort trong bộ nhớ, index này không bắt buộc nhưng vô hại).
create index if not exists idx_places_rating_reviews
  on travel.places (average_rating desc nulls last, review_count desc nulls last);

-- Drop cả 2 chữ ký cũ để đổi được thân hàm (giữ nguyên return type cũ nên
-- backend không cần đổi mapping).
drop function if exists travel.search_autocomplete(text);
drop function if exists travel.search_autocomplete(text, int);

create function travel.search_autocomplete(
    p_query text,
    p_limit int default 20
)
returns table (
    id uuid,
    name text,
    type text,
    image text,
    city text,
    rating float,
    score float
)
language plpgsql
stable
as $$
declare
    nq         text := travel.immutable_unaccent(coalesce(trim(p_query), ''));
    prefix_pat text;   -- 'nq%'  : khớp đầu chuỗi (tính boost + dùng cho query ngắn)
    place_pat  text;   -- mẫu khớp cho PLACE: prefix nếu < 3 ký tự, infix nếu >= 3
    city_pat   text;   -- cities ít dòng → luôn infix
begin
    if nq = '' then
        return;
    end if;

    prefix_pat := nq || '%';
    city_pat   := '%' || nq || '%';
    -- < 3 ký tự: trigram không index được chuỗi ngắn → dùng prefix (btree).
    -- >= 3 ký tự: infix '%q%' dùng GIN trigram.
    place_pat  := case when length(nq) < 3 then prefix_pat else city_pat end;

    -- Dùng EXECUTE để mẫu LIKE là HẰNG trong câu lệnh → planner chắc chắn chọn index.
    return query execute format($q$
        select t.id, t.name, t.type, t.image, t.city, t.rating, t.score
        from (
            -- ===== CITY (bảng nhỏ, ưu tiên hiển thị trên) =====
            select
                c.id,
                c.name::text                          as name,
                'city'::text                          as type,
                ''::text                              as image,
                c.name::text                          as city,
                0::float                              as rating,
                0::bigint                             as review_count,
                (case when travel.immutable_unaccent(c.name) like %L then 100 else 50 end)::float as score
            from travel.cities c
            where travel.immutable_unaccent(c.name) like %L

            union all

            -- ===== PLACE: rank = prefix boost + Bayesian(rating, review_count)/5 =====
            select
                p.id,
                p.name::text                          as name,
                'place'::text                         as type,
                coalesce(p.image_url[1], '')          as image,
                coalesce(ci.name, '')::text           as city,
                coalesce(p.average_rating, 0)::float  as rating,
                coalesce(p.review_count, 0)::bigint   as review_count,
                (
                    (case when travel.immutable_unaccent(p.name) like %L then 3 else 0 end)
                    + (case
                         when coalesce(p.review_count, 0) = 0
                              and coalesce(p.average_rating, 0) = 0 then 0
                         else (
                             (coalesce(p.review_count, 0)::float
                                / (coalesce(p.review_count, 0) + 10))
                               * coalesce(p.average_rating, 0)
                             + (10.0 / (coalesce(p.review_count, 0) + 10)) * 3.0
                         ) / 5.0
                       end)
                )::float                              as score
            from travel.places p
            left join travel.cities ci on ci.id = p.city_id
            where p.is_approved
              and p.is_active
              and travel.immutable_unaccent(p.name) like %L
        ) t
        order by t.score desc, t.rating desc, t.review_count desc
        limit %s
    $q$, prefix_pat, city_pat, prefix_pat, place_pat, greatest(p_limit, 1));
end;
$$;

-- Cập nhật thống kê để planner chọn index ngay.
analyze travel.places;

-- Nạp lại schema cache của PostgREST để API thấy function mới ngay lập tức.
notify pgrst, 'reload schema';

-- Kiểm tra nhanh (chạy thử sau khi Run):
--   select * from travel.search_autocomplete('ha noi', 20);
--   select * from travel.search_autocomplete('pho', 20);
-- Kỳ vọng: các place rating cao + nhiều review có score lớn hơn place rating
-- cao nhưng ít review; city vẫn đứng đầu danh sách.

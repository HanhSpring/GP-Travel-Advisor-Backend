-- =============================================================================
-- Search Optimization — nâng cấp RPC travel.search_autocomplete + index
-- =============================================================================
-- Vấn đề: bảng travel.places > 45.000 dòng, tìm theo `name` (không phải khóa chính)
-- bằng ILIKE '%...%' / similarity() quét tuần tự toàn bảng → chậm / timeout (load fail).
-- Ngoài ra function cũ tham chiếu cột `p.city` (KHÔNG tồn tại) và `GROUP BY p.city`
-- trên toàn bảng places → vừa lỗi vừa nặng; cũng chưa trả ảnh.
--
-- Giải pháp (vẫn giữ kiến trúc gọi RPC search_autocomplete):
--   1) `immutable_unaccent(name)` — bản unaccent + lower IMMUTABLE để dựng được index.
--   2) GIN trigram index trên immutable_unaccent(name) → ILIKE '%q%' và toán tử `%`
--      (similarity) chạy nhanh (sub-100ms) dù wildcard ở đầu.
--   3) Function mới: lấy CITY từ bảng travel.cities (nhỏ), PLACE lọc approved/active,
--      trả thêm image (image_url[1]), city (từ city_id -> cities.name), rating.
--   4) Dùng toán tử `%` thay cho `similarity() > 0.3` để TẬN DỤNG index trigram.
--
-- Cách chạy: Supabase Dashboard -> SQL Editor -> dán toàn bộ file -> Run.
-- Script idempotent: chạy lại nhiều lần không gây lỗi.
-- =============================================================================

create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- -----------------------------------------------------------------------------
-- Dọn artifact của phiên bản migration cũ (nếu trước đó đã chạy bản name_norm).
-- An toàn: chỉ xoá thứ do migration này từng tạo.
-- -----------------------------------------------------------------------------
drop index if exists travel.idx_places_name_norm_trgm;
drop index if exists travel.idx_places_name_norm_prefix;
drop index if exists travel.idx_cities_name_norm_trgm;
drop index if exists travel.idx_cities_name_norm_prefix;
alter table travel.places drop column if exists name_norm;
alter table travel.cities drop column if exists name_norm;

-- -----------------------------------------------------------------------------
-- unaccent là STABLE → không dùng trực tiếp trong functional index được.
-- Bọc lại thành IMMUTABLE (kèm lower) để vừa dựng index vừa dùng trong function,
-- bảo đảm biểu thức index KHỚP biểu thức trong WHERE → planner mới dùng được index.
-- -----------------------------------------------------------------------------
create or replace function travel.immutable_unaccent(txt text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select public.unaccent(lower(txt));
$$;

-- -----------------------------------------------------------------------------
-- Index trigram cho tìm theo tên địa điểm (infix + similarity).
-- -----------------------------------------------------------------------------
-- GIN trigram: cho tìm infix `... LIKE '%q%'` (truy vấn >= 3 ký tự).
create index if not exists idx_places_name_unaccent_trgm
  on travel.places using gin (travel.immutable_unaccent(name) gin_trgm_ops);

-- Btree text_pattern_ops: cho tìm prefix `... LIKE 'q%'` (truy vấn ngắn < 3 ký tự,
-- trigram không xử lý được chuỗi < 3 ký tự).
create index if not exists idx_places_name_unaccent_prefix
  on travel.places (travel.immutable_unaccent(name) text_pattern_ops);

-- Lọc nhanh địa điểm hiển thị được.
create index if not exists idx_places_active_approved
  on travel.places (is_approved, is_active);

-- (cities chỉ ~vài chục dòng nên không cần index.)

-- -----------------------------------------------------------------------------
-- RPC: travel.search_autocomplete(p_query, p_limit)
-- Trả: id, name, type('place'|'city'), image, city, rating, score
--
-- Phải DROP bản cũ trước: function cũ là search_autocomplete(text) trả 4 cột
-- (id,name,type,score). Nếu chỉ CREATE OR REPLACE bản 2 tham số sẽ tạo overload mới
-- mà vẫn còn bản 1 tham số (lỗi p.city) → backend gọi 1 tham số vẫn trúng bản cũ.
-- Drop cả 2 chữ ký rồi tạo lại để đổi được cả return type lẫn tham số.
-- -----------------------------------------------------------------------------
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
    prefix_pat text;   -- 'nq%'  : khớp đầu chuỗi (luôn tính boost + dùng cho query ngắn)
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

    -- Dùng EXECUTE để mẫu LIKE là HẰNG trong câu lệnh → planner chắc chắn chọn index
    -- (trong plpgsql, mẫu là biến thường khiến planner bỏ qua index trigram).
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
                (case when travel.immutable_unaccent(c.name) like %L then 100 else 50 end)::float as score
            from travel.cities c
            where travel.immutable_unaccent(c.name) like %L

            union all

            -- ===== PLACE (lọc approved/active, kèm ảnh + thành phố) =====
            select
                p.id,
                p.name::text                          as name,
                'place'::text                         as type,
                coalesce(p.image_url[1], '')          as image,
                coalesce(ci.name, '')::text           as city,
                coalesce(p.average_rating, 0)::float  as rating,
                (
                    (case when travel.immutable_unaccent(p.name) like %L then 3 else 0 end)
                    + least(coalesce(p.average_rating, 0) / 5.0, 1)
                )::float                              as score
            from travel.places p
            left join travel.cities ci on ci.id = p.city_id
            where p.is_approved
              and p.is_active
              and travel.immutable_unaccent(p.name) like %L
        ) t
        order by t.score desc
        limit %s
    $q$, prefix_pat, city_pat, prefix_pat, place_pat, greatest(p_limit, 1));
end;
$$;

-- Cập nhật thống kê để planner chọn index ngay.
analyze travel.places;

-- Nạp lại schema cache của PostgREST để API thấy signature function mới ngay lập tức.
notify pgrst, 'reload schema';

-- Kiểm tra nhanh (chạy thử sau khi Run):
--   select * from travel.search_autocomplete('ha noi', 20);
--   select * from travel.search_autocomplete('pho', 20);

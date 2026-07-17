-- =============================================================================
-- Search Results Optimization — RPC travel.search_places_full
-- =============================================================================
-- Vấn đề: GET /search/results & /search/all đang query PostgREST
--   .ilike('name', '%q%') trên cột `name` THÔ → không dùng được GIN trigram index
--   (index dựng trên biểu thức travel.immutable_unaccent(name), xem
--   sql/2026_search_optimization.sql) → quét tuần tự >45.000 dòng, mỗi request ~1-2s.
--   Ngoài ra không unaccent nên gõ "da nang" không khớp "Đà Nẵng".
--
-- Giải pháp: RPC search_places_full dùng ĐÚNG biểu thức immutable_unaccent(name)
--   để planner chọn index trigram (infix, >=3 ký tự) / btree prefix (<3 ký tự),
--   đồng thời join sẵn cities + types/categories để backend khỏi query bồi.
--
-- Backend gọi RPC này trong search.service.ts (queryPlaces); nếu function chưa
-- tồn tại sẽ tự fallback về cách cũ nên chạy file này lúc nào cũng an toàn.
--
-- Cách chạy: Supabase Dashboard -> SQL Editor -> dán toàn bộ file -> Run.
-- Script idempotent: chạy lại nhiều lần không gây lỗi.
-- Yêu cầu: đã chạy 2026_search_optimization.sql (immutable_unaccent + index).
-- =============================================================================

drop function if exists travel.search_places_full(text, int);

create function travel.search_places_full(
    p_query text,
    p_limit int default 500
)
returns table (
    id                   uuid,
    name                 text,
    average_rating       float,
    review_count         int,
    image_url            text[],
    city_id              uuid,
    city_name            text,
    open_time            text,
    close_time           text,
    open_hour_compressed text,
    price                text,
    category_name        text
)
language plpgsql
stable
as $$
declare
    nq  text := travel.immutable_unaccent(coalesce(trim(p_query), ''));
    pat text;
begin
    if nq = '' then
        return;
    end if;

    -- < 3 ký tự: trigram không index được → prefix (btree text_pattern_ops).
    -- >= 3 ký tự: infix '%q%' dùng GIN trigram.
    pat := case when length(nq) < 3 then nq || '%' else '%' || nq || '%' end;

    -- EXECUTE với mẫu LIKE là HẰNG để planner chắc chắn chọn index
    -- (giống cách làm của search_autocomplete).
    return query execute format($q$
        select
            p.id,
            p.name::text,
            coalesce(p.average_rating, 0)::float      as average_rating,
            coalesce(p.review_count, 0)::int          as review_count,
            p.image_url,
            p.city_id,
            coalesce(ci.name, '')::text               as city_name,
            p.open_time::text,
            p.close_time::text,
            p.open_hour_compressed::text,
            p.price::text,
            coalesce(c.name, '')::text                as category_name
        from travel.places p
        left join travel.cities     ci on ci.id = p.city_id
        left join travel.types      t  on t.id  = p.type_id
        left join travel.categories c  on c.id  = t.category_id
        where p.is_approved
          and p.is_active
          and travel.immutable_unaccent(p.name) like %L
        order by coalesce(p.average_rating, 0) desc,
                 coalesce(p.review_count, 0) desc
        limit %s
    $q$, pat, greatest(p_limit, 1));
end;
$$;

-- Nạp lại schema cache của PostgREST để API thấy function mới ngay.
notify pgrst, 'reload schema';

-- Kiểm tra nhanh sau khi Run:
--   select id, name, city_name, category_name from travel.search_places_full('da nang', 20);
--   select count(*) from travel.search_places_full('ha noi', 500);

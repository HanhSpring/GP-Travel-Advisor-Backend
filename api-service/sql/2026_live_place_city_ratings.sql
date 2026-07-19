-- Keep denormalized place ratings correct and rank cities in PostgreSQL.
-- Run once against Supabase before deploying the matching API version.

-- Optional performance indexes. The trigger and RPC below work without them.
-- Install these later if EXPLAIN ANALYZE shows the rating queries need them:
--
-- create index if not exists idx_reviews_approved_place_rating
--   on review_ai.reviews (place_id, rating)
--   where status = 'approved' and place_id is not null;
--
-- create index if not exists idx_places_active_city_rating
--   on travel.places (city_id, average_rating, review_count)
--   where is_approved = true and is_active = true;

create or replace function review_ai.refresh_place_rating(p_place_id uuid)
returns void
language plpgsql
security definer
set search_path = review_ai, travel, public
as $$
declare
  v_average numeric;
  v_count bigint;
begin
  if p_place_id is null then
    return;
  end if;

  select coalesce(avg(r.rating), 0), count(*)
    into v_average, v_count
  from review_ai.reviews r
  where r.place_id = p_place_id
    and r.status = 'approved';

  update travel.places
  set average_rating = round(v_average, 2),
      review_count = v_count
  where id = p_place_id;
end;
$$;

create or replace function review_ai.sync_place_rating_from_review()
returns trigger
language plpgsql
security definer
set search_path = review_ai, travel, public
as $$
begin
  if tg_op = 'DELETE' then
    perform review_ai.refresh_place_rating(old.place_id);
    return old;
  end if;

  perform review_ai.refresh_place_rating(new.place_id);

  if tg_op = 'UPDATE' and old.place_id is distinct from new.place_id then
    perform review_ai.refresh_place_rating(old.place_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_place_rating on review_ai.reviews;
create trigger trg_sync_place_rating
after insert or update of rating, status, place_id or delete
on review_ai.reviews
for each row execute function review_ai.sync_place_rating_from_review();

-- Backfill in one review scan + one place join. This intentionally avoids a
-- correlated NOT EXISTS per place, which is too slow without an index.
with rating_stats as materialized (
  select
    r.place_id,
    round(avg(r.rating)::numeric, 2) as average_rating,
    count(*)::bigint as review_count
  from review_ai.reviews r
  where r.status = 'approved'
    and r.place_id is not null
  group by r.place_id
), recalculated as materialized (
  select
    p.id,
    coalesce(s.average_rating, 0) as average_rating,
    coalesce(s.review_count, 0) as review_count
  from travel.places p
  left join rating_stats s on s.place_id = p.id
)
update travel.places p
set average_rating = r.average_rating,
    review_count = r.review_count
from recalculated r
where p.id = r.id
  and (
    p.average_rating is distinct from r.average_rating
    or p.review_count is distinct from r.review_count
  );

create or replace function travel.get_featured_cities_ranked(
  p_offset integer default 0,
  p_limit integer default 10
)
returns table (
  id uuid,
  name text,
  image_url text,
  rating double precision,
  review_count bigint,
  quality_score double precision,
  total_count bigint
)
language sql
stable
set search_path = travel, public
as $$
  with city_stats as (
    select
      c.id,
      c.name::text as name,
      c.image_url::text as image_url,
      coalesce(
        sum(p.average_rating * greatest(p.review_count, 1))
          filter (where p.average_rating > 0)
        / nullif(
            sum(greatest(p.review_count, 1))
              filter (where p.average_rating > 0),
            0
          ),
        0
      )::double precision as rating,
      coalesce(sum(p.review_count), 0)::bigint as review_count
    from travel.cities c
    left join travel.places p
      on p.city_id = c.id
     and p.is_approved = true
     and p.is_active = true
    group by c.id, c.name, c.image_url
  ), ranked as (
    select
      cs.*,
      case
        when cs.review_count = 0 then 0
        else (
          cs.review_count::double precision / (cs.review_count + 20)
        ) * cs.rating + (
          20::double precision / (cs.review_count + 20)
        ) * 3.5
      end as quality_score
    from city_stats cs
  )
  select
    r.id,
    r.name,
    r.image_url,
    round(r.rating::numeric, 2)::double precision,
    r.review_count,
    r.quality_score,
    count(*) over () as total_count
  from ranked r
  order by r.quality_score desc, r.review_count desc, r.name asc, r.id asc
  offset greatest(p_offset, 0)
  limit least(greatest(p_limit, 1), 100);
$$;

grant execute on function travel.get_featured_cities_ranked(integer, integer)
  to anon, authenticated, service_role;

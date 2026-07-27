-- Speed up the add/replace-place search used by GET /search/nearby.
-- The existing endpoint applies ILIKE directly to places.name, so PostgreSQL
-- cannot use idx_places_name_unaccent_trgm and returns every matching row to
-- Node.js before distance sorting and limiting.

create index if not exists idx_places_active_geo
  on travel.places (latitude, longitude)
  where is_approved = true
    and is_active = true
    and latitude is not null
    and longitude is not null;

create or replace function travel.search_nearby_places(
  p_lat double precision,
  p_lng double precision,
  p_limit integer default 20,
  p_exclude_ids uuid[] default '{}'::uuid[],
  p_prefer_category text default '',
  p_radius_km double precision default 10,
  p_query text default ''
)
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with candidates as (
    select
      p.id,
      p.name,
      p.address,
      p.average_rating,
      p.review_count,
      p.price,
      p.image_url,
      p.latitude,
      p.longitude,
      p.open_hour_compressed,
      coalesce(cat.name, 'Tham quan') as category_name,
      6371.0 * acos(
        least(
          1.0,
          greatest(
            -1.0,
            cos(radians(p_lat))
              * cos(radians(p.latitude::double precision))
              * cos(
                  radians(p.longitude::double precision)
                    - radians(p_lng)
                )
              + sin(radians(p_lat))
                * sin(radians(p.latitude::double precision))
          )
        )
      ) as distance_km
    from travel.places p
    left join travel.types t on t.id = p.type_id
    left join travel.categories cat on cat.id = t.category_id
    where p.is_approved = true
      and p.is_active = true
      and p.latitude is not null
      and p.longitude is not null
      and p.latitude between
        p_lat - p_radius_km / 111.32
        and p_lat + p_radius_km / 111.32
      and p.longitude between
        p_lng - p_radius_km
          / (111.32 * greatest(abs(cos(radians(p_lat))), 0.01))
        and p_lng + p_radius_km
          / (111.32 * greatest(abs(cos(radians(p_lat))), 0.01))
      and not (
        p.id = any(coalesce(p_exclude_ids, '{}'::uuid[]))
      )
      -- This expression matches idx_places_name_unaccent_trgm.
      and (
        coalesce(trim(p_query), '') = ''
        or travel.immutable_unaccent(p.name)
          ilike '%' || travel.immutable_unaccent(trim(p_query)) || '%'
      )
  ),
  filtered as (
    select *
    from candidates
    where distance_km <= p_radius_km
      and (
        lower(trim(coalesce(p_prefer_category, ''))) <> 'tham quan'
        or not (
          lower(category_name) like '%nhà hàng%'
          or lower(category_name) like '%khách sạn%'
          or lower(category_name) like '%quán ăn%'
          or lower(category_name) like '%lưu trú%'
          or lower(category_name) like '%ẩm thực%'
          or lower(category_name) like '%quán cà phê%'
          or lower(category_name) like '%cafe%'
        )
      )
  )
  select jsonb_build_object(
    'id', id,
    'name', name,
    'address', coalesce(address, ''),
    'category', category_name,
    'rating', coalesce(average_rating, 0),
    'reviewCount', coalesce(review_count, 0),
    'estimatedCost', coalesce(price, 0),
    'imageUrl', coalesce(
      image_url[1],
      'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=600&q=80'
    ),
    'distanceKm', round(distance_km::numeric, 1),
    'latitude', latitude,
    'longitude', longitude,
    'isSameCategory',
      lower(trim(category_name))
        = lower(trim(coalesce(p_prefer_category, ''))),
    'openHourCompressed', open_hour_compressed
  )
  from filtered
  order by
    (
      lower(trim(category_name))
        = lower(trim(coalesce(p_prefer_category, '')))
    ) desc,
    distance_km asc,
    average_rating desc nulls last,
    review_count desc nulls last
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

grant execute on function travel.search_nearby_places(
  double precision,
  double precision,
  integer,
  uuid[],
  text,
  double precision,
  text
) to authenticated, service_role;

notify pgrst, 'reload schema';

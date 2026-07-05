-- Speed up the partner dashboard's "locations" and "orders" list screens.
-- These columns are filtered/joined on every request but had no index,
-- forcing a sequential scan as the tables grow.

create index if not exists idx_places_vendor_id on travel.places (vendor_id);
create index if not exists idx_places_type_id on travel.places (type_id);
create index if not exists idx_places_city_id on travel.places (city_id);

create index if not exists idx_reviews_place_id on review_ai.reviews (place_id);

create index if not exists idx_orders_place_id on order_sys.orders (place_id);
create index if not exists idx_orders_status on order_sys.orders (status);

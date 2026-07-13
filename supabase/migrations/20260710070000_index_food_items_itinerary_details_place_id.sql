-- Them index cho cac cot place_id dang ON DELETE CASCADE nhung chua co index,
-- khien cascade delete tu travel.places bi cham/timeout (vd: order_sys.food_items
-- co ~273k dong, moi lan xoa 1 place phai quet tuan tu toan bo bang).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_food_items_place_id
  ON order_sys.food_items USING btree (place_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_itinerary_details_place_id
  ON travel.itinerary_details USING btree (place_id);

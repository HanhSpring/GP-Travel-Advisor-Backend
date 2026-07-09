-- Snapshot of the "quality layer" for each day of the generated itinerary,
-- computed once at creation time from the planner's stopped_reason/
-- meal_violations per day. Empty array = every day was a perfect (layer 1)
-- solve, nothing to show the user.
alter table travel.itineraries
  add column if not exists day_quality jsonb not null default '[]'::jsonb;

comment on column travel.itineraries.day_quality
  is 'Mảng [{day, date, layer, message}] — layer 2 (giờ ăn trưa được dời), layer 3 (bỏ nhà hàng), layer 4 (greedy fallback). Layer 1 (hoàn hảo) không có entry.';

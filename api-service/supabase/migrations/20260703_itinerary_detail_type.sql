alter table travel.itinerary_details
  add column if not exists detail_type varchar(20) not null default 'ACTIVITY',
  add column if not exists travel_distance_km numeric(10, 3) not null default 0;

update travel.itinerary_details
set detail_type = 'HOTEL'
where sequence_order = 0
  and coalesce(duration_minutes, 0) = 0;

alter table travel.itinerary_details
  drop constraint if exists itinerary_details_detail_type_check;

alter table travel.itinerary_details
  add constraint itinerary_details_detail_type_check
  check (detail_type in ('HOTEL', 'ACTIVITY'));

alter table travel.itinerary_details
  drop constraint if exists itinerary_details_travel_distance_check;

alter table travel.itinerary_details
  add constraint itinerary_details_travel_distance_check
  check (travel_distance_km >= 0);

create index if not exists itinerary_details_itinerary_type_idx
  on travel.itinerary_details (itinerary_id, detail_type);

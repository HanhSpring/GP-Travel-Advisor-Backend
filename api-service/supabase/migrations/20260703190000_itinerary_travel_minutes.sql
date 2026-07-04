alter table travel.itinerary_details
  add column if not exists travel_minutes integer not null default 0;

alter table travel.itinerary_details
  drop constraint if exists itinerary_details_travel_minutes_check;

alter table travel.itinerary_details
  add constraint itinerary_details_travel_minutes_check
  check (travel_minutes >= 0);

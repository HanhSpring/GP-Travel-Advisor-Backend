-- Reusable route cache. This table complements itinerary_details; it does not
-- replace the route snapshot stored for an already generated itinerary.
create table if not exists travel.distance_matrix (
  origin_place_id uuid not null,
  destination_place_id uuid not null,
  travel_mode varchar(20) not null default 'DRIVING',
  distance_meters integer not null,
  duration_seconds integer not null,
  updated_at timestamp without time zone not null default now(),
  constraint distance_matrix_pkey
    primary key (origin_place_id, destination_place_id, travel_mode),
  constraint distance_matrix_origin_fkey
    foreign key (origin_place_id)
    references travel.places (id)
    on delete cascade,
  constraint distance_matrix_destination_fkey
    foreign key (destination_place_id)
    references travel.places (id)
    on delete cascade,
  constraint distance_matrix_positive_check
    check (distance_meters >= 0 and duration_seconds >= 0),
  constraint distance_matrix_distinct_places_check
    check (origin_place_id <> destination_place_id)
);

create index if not exists idx_distance_matrix_origin
  on travel.distance_matrix (origin_place_id);

create index if not exists idx_distance_matrix_destination
  on travel.distance_matrix (destination_place_id);

create index if not exists idx_distance_matrix_updated_at
  on travel.distance_matrix (updated_at);

alter table travel.itineraries
  add column if not exists travel_mode varchar(20) not null default 'DRIVING';

alter table travel.itineraries
  drop constraint if exists itineraries_travel_mode_check;

alter table travel.itineraries
  add constraint itineraries_travel_mode_check
  check (travel_mode in ('DRIVING', 'MOTORBIKE'));

-- Expand itinerary_details in place. Do not drop/recreate this table because it
-- is referenced by tracking data and may already contain generated itineraries.
alter table travel.itinerary_details
  add column if not exists detail_type varchar(20) not null default 'ACTIVITY',
  add column if not exists departure_time time without time zone,
  add column if not exists transport_cost numeric(12, 2),
  add column if not exists travel_distance_km numeric(10, 3) not null default 0,
  add column if not exists travel_minutes integer not null default 0;

alter table travel.itinerary_details
  drop constraint if exists itinerary_details_detail_type_check;

alter table travel.itinerary_details
  add constraint itinerary_details_detail_type_check
  check (detail_type in ('HOTEL', 'ACTIVITY'));

alter table travel.itinerary_details
  drop constraint if exists itinerary_details_travel_snapshot_check;

alter table travel.itinerary_details
  add constraint itinerary_details_travel_snapshot_check
  check (
    travel_distance_km >= 0
    and travel_minutes >= 0
    and (transport_cost is null or transport_cost >= 0)
  );

create index if not exists idx_itinerary_details_itinerary_sequence
  on travel.itinerary_details (itinerary_id, visit_date, sequence_order);

create index if not exists idx_itinerary_details_itinerary_type
  on travel.itinerary_details (itinerary_id, detail_type);

-- Deploy the API version that reads travel.distance_matrix before applying
-- this contract migration.
alter table travel.itinerary_details
  drop column if exists departure_time,
  drop column if exists transport_cost,
  drop column if exists travel_distance_km,
  drop column if exists travel_minutes;

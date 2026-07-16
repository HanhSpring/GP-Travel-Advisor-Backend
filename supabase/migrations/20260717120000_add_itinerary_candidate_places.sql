-- Two-Tower candidates fetched at itinerary creation but not chosen by the
-- planner ("leftover"), reused for add-place suggestions. Only place_id is
-- stored; rating/review_count are read fresh from travel.places on query.
create table "travel"."itinerary_candidate_places" (
  "id" uuid primary key default gen_random_uuid(),
  "itinerary_id" uuid not null references "travel"."itineraries"("id") on delete cascade,
  "place_id" uuid not null references "travel"."places"("id") on delete cascade,
  "created_at" timestamp with time zone not null default now(),
  unique ("itinerary_id", "place_id")
);

create index "idx_itinerary_candidate_places_itinerary_id"
  on "travel"."itinerary_candidate_places" ("itinerary_id");

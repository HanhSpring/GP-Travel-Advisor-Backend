-- The "quality layer" warning banner (added in 20260709_itineraries_day_quality.sql)
-- has been removed from the app entirely — the column is no longer read or
-- written anywhere in api-service or the mobile app. Dropping it here.
alter table travel.itineraries
  drop column if exists day_quality;

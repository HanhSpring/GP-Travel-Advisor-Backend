-- Split travel.incurred_costs into 2 conceptually different kinds of entry:
--   - 'Điều chỉnh giá': the real price of a place differs from the system
--     estimate. Owner-only, always tied to a place, changes the shared
--     per-adult base cost for everyone (never charged_to specific members).
--     amount is the DELTA from the estimated price, so it can be negative
--     (the real price was lower) and multiple corrections over time compose
--     additively.
--   - everything else ('Nước uống'/'Quà tặng'/'Mua sắm'/'Phí gửi xe'/'Khác'):
--     unchanged "ad-hoc spend" behavior — any member logs it, positive
--     amount only, charged to whoever is ticked (empty = split evenly
--     across real accounts).
--
-- Giá trị lưu là tiếng Việt có dấu — toàn hệ thống (DB, API, mobile) dùng
-- chung 1 chuỗi này, không có bản dịch/slug tiếng Anh nào khác đứng giữa.

alter table travel.incurred_costs
  add column if not exists type text not null default 'Khác';

alter table travel.incurred_costs
  drop constraint if exists incurred_costs_type_check;
alter table travel.incurred_costs
  add constraint incurred_costs_type_check
  check (type in ('Điều chỉnh giá', 'Nước uống', 'Quà tặng', 'Mua sắm', 'Phí gửi xe', 'Khác'));

-- amount > 0 no longer holds unconditionally: a 'Điều chỉnh giá' may be
-- negative (correcting an overestimate).
alter table travel.incurred_costs
  drop constraint if exists incurred_costs_amount_check;
alter table travel.incurred_costs
  add constraint incurred_costs_amount_check
  check (type = 'Điều chỉnh giá' or amount > 0);

alter table travel.incurred_costs
  drop constraint if exists incurred_costs_price_adjustment_place_check;
alter table travel.incurred_costs
  add constraint incurred_costs_price_adjustment_place_check
  check (type <> 'Điều chỉnh giá' or place_id is not null);

alter table travel.incurred_costs
  add column if not exists updated_by uuid null references public.users(id);

comment on column travel.incurred_costs.type
  is '''Điều chỉnh giá'' = owner-only correction to a place''s estimated price (amount is a delta, place_id required, charged_to forced empty). Other values (''Nước uống'', ''Quà tặng'', ''Mua sắm'', ''Phí gửi xe'', ''Khác'') are ad-hoc personal spend: creator-only edit, no owner override.';
comment on column travel.incurred_costs.amount
  is 'Positive add-on for ad-hoc types (Nước uống/Quà tặng/Mua sắm/Phí gửi xe/Khác). For ''Điều chỉnh giá'': signed delta from the place''s system-estimated price (can be negative).';
comment on column travel.incurred_costs.updated_by
  is 'Who last edited this row (null if never edited after creation).';

-- itinerary_details.actual_cost is selected in itinerary.service.ts but
-- never actually read (confirmed via grep) — the new type-aware cost table
-- above is the single source of truth for any price correction going
-- forward, so this column is now fully redundant.
alter table travel.itinerary_details
  drop column if exists actual_cost;

-- itinerary_details.cost_updated_at: zero references anywhere in the repo
-- (no query, DTO, or code touches it) — dead alongside actual_cost.
alter table travel.itinerary_details
  drop column if exists cost_updated_at;

-- itineraries.actual_cost: read at itinerary.service.ts's getItineraryDetail()
-- into the API's `spentBudget` field, but nothing in the entire repo ever
-- writes to this column (no INSERT/UPDATE sets it — confirmed via grep, and
-- the one DTO that looked like a write path, UpdateItineraryActivityDto's
-- `actualCost`, is itself never imported/used by any controller or service).
-- So `spentBudget` has always resolved to 0 for every itinerary. Superseded
-- by the new incurred_costs-based `spentSoFar` (Card 2), which correctly
-- excludes skipped/unvisited places — this column never did.
alter table travel.itineraries
  drop column if exists actual_cost;

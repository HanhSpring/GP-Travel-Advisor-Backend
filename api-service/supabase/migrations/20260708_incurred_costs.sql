create table if not exists travel.incurred_costs (
  id uuid primary key default gen_random_uuid(),
  itinerary_id uuid not null references travel.itineraries(id) on delete cascade,
  place_id uuid null references travel.places(id) on delete set null,
  note text not null check (char_length(trim(note)) > 0),
  amount numeric(14, 2) not null check (amount > 0),
  -- Mảng user_id (uuid dạng text) của những người phải gánh khoản chi này.
  -- Rỗng ([]) nghĩa là chia đều cho cả nhóm (theo adult_count + child_count
  -- có trọng số trẻ em, xem TripCostConfigService.childPriceRatio).
  charged_to jsonb not null default '[]'::jsonb,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_incurred_costs_itinerary
  on travel.incurred_costs (itinerary_id);

create index if not exists idx_incurred_costs_place
  on travel.incurred_costs (place_id);

create index if not exists idx_incurred_costs_created_by
  on travel.incurred_costs (created_by);

comment on table travel.incurred_costs
  is 'Chi phí phát sinh người dùng ghi nhận trong chuyến đi (mục 1.6-1.7), gắn hoặc không gắn với 1 địa điểm cụ thể.';

comment on column travel.incurred_costs.charged_to
  is 'Mảng user_id phải gánh khoản chi này. Rỗng = chia đều cho cả nhóm theo (adult_count + child_count * childPriceRatio).';

comment on column travel.incurred_costs.created_by
  is 'Người ghi nhận khoản chi này — dùng để kiểm tra quyền sửa/xoá của Member (Owner luôn sửa/xoá được mọi khoản).';

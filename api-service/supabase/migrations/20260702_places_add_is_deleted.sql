-- Add is_deleted for soft-delete, freeing is_active to track public visibility
alter table travel.places
  add column if not exists is_deleted boolean not null default false;

-- Migrate: existing soft-deleted rows (is_active = false) → is_deleted = true
update travel.places
  set is_deleted = true
  where is_active = false;

-- Fix pending places (is_approved IS NULL): must not be publicly visible
update travel.places
  set is_active = false
  where is_deleted = false
    and is_approved is null;

-- Fix rejected places (is_approved = false): must not be publicly visible
update travel.places
  set is_active = false
  where is_deleted = false
    and is_approved = false;

comment on column travel.places.is_deleted
  is 'Soft-delete flag. true = đã bị xóa, ẩn khỏi mọi query. Không dùng is_active cho mục đích này nữa.';

comment on column travel.places.is_active
  is 'Public visibility. false = chờ duyệt / từ chối / ẩn. true = đã duyệt và đang hiển thị với người dùng.';

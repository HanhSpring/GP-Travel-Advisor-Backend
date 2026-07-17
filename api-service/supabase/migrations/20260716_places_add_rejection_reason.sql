alter table travel.places
  add column rejection_reason text null;

comment on column travel.places.rejection_reason
  is 'Lý do admin từ chối địa điểm gần nhất. Được xóa khi địa điểm được duyệt lại.';

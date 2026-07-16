-- order_sys.orders.ordered_at is intentionally a timestamp without time zone.
-- Keep its default aligned with the Vietnam wall-clock value written by the API.
alter table order_sys.orders
  alter column ordered_at
  set default timezone('Asia/Ho_Chi_Minh', now());

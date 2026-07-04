-- Add place_id, confirmed_at, auto_complete_at to order_sys.orders
-- place_id: links order to a place (for joining estimated_preparation_time)
-- confirmed_at: timestamp when restaurant confirmed the order
-- auto_complete_at: precomputed timestamp when order should auto-transition to 'completed'

alter table order_sys.orders
  add column if not exists place_id uuid null,
  add column if not exists confirmed_at timestamptz null,
  add column if not exists auto_complete_at timestamptz null;

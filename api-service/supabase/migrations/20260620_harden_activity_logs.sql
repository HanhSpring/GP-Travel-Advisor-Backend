-- Keep created_at unchanged by design.
-- Normalize the legacy backend value before enforcing the supported actions.
update travel.activity_logs
set action_type = 'review'
where action_type = 'write_review';

alter table travel.activity_logs
  alter column tourist_id set not null,
  alter column action_type set not null;

alter table travel.activity_logs
  drop constraint if exists activity_logs_action_type_check;

alter table travel.activity_logs
  add constraint activity_logs_action_type_check
  check (
    action_type in (
      'click',
      'view',
      'save',
      'unsave',
      'search',
      'visited',
      'review',
      'rating'
    )
  );

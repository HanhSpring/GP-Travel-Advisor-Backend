-- Admin-triggered local recommender retraining.
-- Uses the existing ai_config tables; no Colab paths or state are involved.

alter type ai_config.training_run_type_enum add value if not exists 'full';
alter type ai_config.training_run_status_enum add value if not exists 'pending';
alter type ai_config.training_run_status_enum add value if not exists 'running';
alter type ai_config.training_run_status_enum add value if not exists 'completed';
alter type ai_config.training_run_status_enum add value if not exists 'failed';
alter type ai_config.training_trigger_type_enum add value if not exists 'manual';
alter type ai_config.training_trigger_type_enum add value if not exists 'scheduled';
alter type ai_config.model_version_status_enum add value if not exists 'candidate';
alter type ai_config.model_version_status_enum add value if not exists 'active';
alter type ai_config.model_version_status_enum add value if not exists 'archived';

create or replace function ai_config.create_recommender_training_run(
  p_algorithm_id uuid,
  p_trigger_type text,
  p_triggered_by uuid,
  p_max_runs integer default 50
)
returns ai_config.training_runs
language plpgsql
security definer
set search_path = ai_config, public
as $$
declare
  v_count integer;
  v_active integer;
  v_run ai_config.training_runs;
begin
  -- Serializes quota/concurrency checks even when two Admin requests arrive together.
  perform pg_advisory_xact_lock(hashtext('recommender_retrain:' || p_algorithm_id::text));

  select count(*) into v_count
  from ai_config.training_runs
  where algorithm_id = p_algorithm_id;

  if v_count >= p_max_runs then
    raise exception 'RETRAIN_LIMIT_REACHED';
  end if;

  select count(*) into v_active
  from ai_config.training_runs
  where algorithm_id = p_algorithm_id
    and status in (
      'pending'::ai_config.training_run_status_enum,
      'running'::ai_config.training_run_status_enum
    );

  if v_active > 0 then
    raise exception 'RETRAIN_ALREADY_RUNNING';
  end if;

  insert into ai_config.training_runs (
    algorithm_id,
    run_type,
    status,
    trigger_type,
    triggered_by,
    metrics
  ) values (
    p_algorithm_id,
    'full'::ai_config.training_run_type_enum,
    'pending'::ai_config.training_run_status_enum,
    p_trigger_type::ai_config.training_trigger_type_enum,
    p_triggered_by,
    jsonb_build_object('progress', 0, 'current_step', 'queued')
  ) returning * into v_run;

  return v_run;
end;
$$;

revoke all on function ai_config.create_recommender_training_run(uuid, text, uuid, integer)
from public;
grant execute on function ai_config.create_recommender_training_run(uuid, text, uuid, integer)
to service_role;

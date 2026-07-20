-- Fix: "column reference email is ambiguous" in survey_upsert_participant.
-- The RETURNS TABLE output column `email` is also a PL/pgSQL variable, so
-- ON CONFLICT (email) is ambiguous. Target the named unique constraint.

CREATE OR REPLACE FUNCTION public.survey_upsert_participant(
  p_user_id uuid,
  p_email text,
  p_age_group text,
  p_travel_frequency text,
  p_travel_style text,
  p_planning_frequency text
)
RETURNS TABLE (
  participant_id uuid,
  user_id uuid,
  email text,
  status text,
  current_itinerary_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO survey.participants (
    user_id,
    email,
    age_group,
    travel_frequency,
    travel_style,
    planning_frequency
  )
  VALUES (
    p_user_id,
    lower(trim(p_email)),
    p_age_group,
    p_travel_frequency,
    p_travel_style,
    p_planning_frequency
  )
  ON CONFLICT ON CONSTRAINT survey_participants_email_unique DO UPDATE SET
    age_group = EXCLUDED.age_group,
    travel_frequency = EXCLUDED.travel_frequency,
    travel_style = EXCLUDED.travel_style,
    planning_frequency = EXCLUDED.planning_frequency,
    last_seen_at = now(),
    updated_at = now();

  RETURN QUERY
  SELECT p.id, p.user_id, p.email, p.status, p.current_itinerary_id
  FROM survey.participants p
  WHERE p.email = lower(trim(p_email))
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.survey_upsert_participant(uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.survey_upsert_participant(uuid, text, text, text, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

import './load-env';
import { createClient } from '@supabase/supabase-js';
import { createLimitedFetch } from './supabase-http';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: { fetch: createLimitedFetch() },
});

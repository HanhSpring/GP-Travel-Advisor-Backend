import { AppConfig } from './app.config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = AppConfig.SUPABASE_URL;
const supabaseKey = AppConfig.SUPABASE_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

import { config } from 'dotenv';
import { resolve } from 'node:path';

// Always use api-service/.env for the active Supabase database, regardless of
// whether NestJS is launched from the repository root or api-service/.
const envPath = resolve(__dirname, '..', '..', '.env');
const parsed = config({ path: envPath }).parsed ?? {};

for (const key of ['SUPABASE_URL', 'SUPABASE_KEY'] as const) {
  const value = parsed[key]?.trim();
  if (value) process.env[key] = value;
}

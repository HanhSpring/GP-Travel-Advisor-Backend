import { config, parse } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Always use api-service/.env for the active Supabase database, regardless of
// whether NestJS is launched from the repository root or api-service/.
const envPath = resolve(__dirname, '..', '..', '.env');
const parsed = config({ path: envPath }).parsed ?? {};

for (const key of [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'BUSINESS_PLACES_USE_ORDERED_QUERY',
  'ADMIN_PLACES_STATS_QUERY_TIMEOUT_MS',
] as const) {
  const value = parsed[key]?.trim();
  if (value) process.env[key] = value;
}

// Routing configuration is shared by the API and AI service at repository
// level. Read only the Goong key from there so the API keeps using its own
// database configuration from api-service/.env.
if (!process.env.GOONG_API_KEY?.trim()) {
  const repositoryEnvPath = resolve(__dirname, '..', '..', '..', '.env');
  if (existsSync(repositoryEnvPath)) {
    const repositoryEnv = parse(readFileSync(repositoryEnvPath));
    const goongApiKey = repositoryEnv.GOONG_API_KEY?.trim();
    if (goongApiKey) process.env.GOONG_API_KEY = goongApiKey;
  }
}

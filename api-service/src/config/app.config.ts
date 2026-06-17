import * as dotenv from 'dotenv';
dotenv.config();

export const AppConfig = {
  AI_SERVICE_URL: process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000',
  AI_SERVICE_TIMEOUT_MS: Number(process.env.AI_SERVICE_TIMEOUT_MS || 2500),
  DEFAULT_PLACE_IMAGE_URL: process.env.DEFAULT_PLACE_IMAGE_URL || 'https://placehold.co/1080x720?text=No+Image',
  EXPLORE_CACHE_TTL_MS: Number(process.env.EXPLORE_CACHE_TTL_MS ?? 300000),
  EXPLORE_MAX_IN_FILTER_IDS: Number(process.env.EXPLORE_MAX_IN_FILTER_IDS ?? 500),
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_KEY: process.env.SUPABASE_KEY || '',
  ADMIN_PLACES_METADATA_CACHE_TTL_MS: Number(process.env.ADMIN_PLACES_METADATA_CACHE_TTL_MS ?? 300000),
  ADMIN_PLACES_MAX_IN_FILTER_IDS: Number(process.env.ADMIN_PLACES_MAX_IN_FILTER_IDS ?? 200),
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
  API_SERVICE_HOST: process.env.API_SERVICE_HOST || '0.0.0.0',
  API_SERVICE_PORT: Number(process.env.API_SERVICE_PORT || 3000),
  API_SERVICE_PORT_RETRIES: Number(process.env.API_SERVICE_PORT_RETRIES || 20),
};

/**
 * Demo settings. `apps/telephony-demo/.env` is optional; when it exists it is
 * loaded here, before anything reads process.env. Every variable is described
 * in `.env.example`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
export const ENV_FILE = join(APP_DIR, '.env');
export const ENV_FILE_LOADED = existsSync(ENV_FILE);

if (ENV_FILE_LOADED) {
  process.loadEnvFile(ENV_FILE);
}

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `${name} must be a port number from 1 to 65535 (got "${raw}")`,
    );
  }
  return value;
}

export const PORTS = {
  web: port('DEMO_WEB_PORT', 3000),
  gateway: port('DEMO_GATEWAY_PORT', 8080),
  fourPoints: port('DEMO_FOURPOINTS_PORT', 8787),
};

export const STAND_IN_HOST = process.env['DEMO_FOURPOINTS_HOST'] || '127.0.0.1';

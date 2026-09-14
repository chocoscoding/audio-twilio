/**
 * @fourpoints/telephony entrypoint.
 *
 *   node --env-file=apps/telephony/.env apps/telephony/dist/index.js
 */

import { createAuthHeaders } from './auth.js';
import { loadConfig, type TelephonyConfig } from './config.js';
import { fetchLanguages, type FourPointsTarget } from './fourpoints.js';
import { LanguageRegistry } from './languages.js';
import { log } from './log.js';
import { createTelephonyServer } from './server.js';

const LANGUAGE_REFRESH_MS = 5 * 60_000;
/** Fits inside a 30 s container stop timeout; raise both together. */
const DRAIN_TIMEOUT_MS = 25_000;

let config: TelephonyConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const target: FourPointsTarget = {
  url: config.fourPointsUrl,
  authHeaders: createAuthHeaders(config.fourPointsAuth),
};

const registry = new LanguageRegistry({
  fetchLanguages: () => fetchLanguages(target),
  clinicianLanguageId: config.clinicianLanguageId,
  order: config.menuLanguageOrder,
  refreshMs: LANGUAGE_REFRESH_MS,
});
registry.start();

const server = await createTelephonyServer({
  config,
  target,
  menu: () => registry.menu,
});
log('telephony.listening', {
  port: server.port,
  fourPoints: config.fourPointsUrl,
  auth: config.fourPointsAuth.mode,
  maxCalls: config.maxCalls,
});

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) {
    return;
  }
  stopping = true;
  log('telephony.draining', { signal, activeCalls: server.activeCalls });
  registry.stop();
  void server.close(DRAIN_TIMEOUT_MS).then(() => {
    log('telephony.stopped');
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

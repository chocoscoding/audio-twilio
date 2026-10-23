/**
 * @fourpoints/telephony entrypoint.
 *
 *   node --env-file=apps/telephony/.env apps/telephony/dist/index.js
 */

import { createAccessClient } from './access.js';
import { createAuthHeaders } from './auth.js';
import { COMPANIES, StaticCompanySource } from './companies.js';
import { loadConfig, type TelephonyConfig } from './config.js';
import { fetchLanguages, type FourPointsTarget } from './fourpoints.js';
import { LanguageRegistry, staticMenu } from './languages.js';
import { log } from './log.js';
import { openPresentationLogs } from './presentation-log.js';
import { PromptLibrary } from './prompts.js';
import { createTelephonyServer } from './server.js';
import { createTwilioRest } from './twilio-rest.js';

const LANGUAGE_REFRESH_MS = 5 * 60_000;
/** Fits inside a 30 s container stop timeout; raise both together. */
const DRAIN_TIMEOUT_MS = 25_000;

let config: TelephonyConfig;
let companies: StaticCompanySource;
try {
  config = loadConfig(process.env);
  companies = StaticCompanySource.from(COMPANIES);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const target: FourPointsTarget = {
  url: config.fourPointsUrl,
  authHeaders: createAuthHeaders(config.fourPointsAuth),
};

// The organization line's code check and usage, through the control-plane
// API. Same machine client, its own scope (and so its own token).
const access =
  config.fourPointsApiUrl === undefined
    ? undefined
    : createAccessClient(
        config.fourPointsApiUrl,
        createAuthHeaders(
          config.fourPointsAuth.mode === 'none'
            ? config.fourPointsAuth
            : { ...config.fourPointsAuth, scope: config.fourPointsPhoneScope },
        ),
      );

// Human calls on a company's own interpreter line are relayed through the
// gateway (relay.ts), which rings that line with the Twilio REST API; without
// an API key they use plain <Dial> and ### can't leave them.
const rest =
  config.twilioApiKey === undefined
    ? undefined
    : createTwilioRest({
        accountSid: config.twilioAccountSid,
        apiKeySid: config.twilioApiKey.sid,
        apiKeySecret: config.twilioApiKey.secret,
      });

const registry = new LanguageRegistry({
  fetchLanguages: () => fetchLanguages(target),
  clinicianLanguageId: config.clinicianLanguageId,
  order: config.menuLanguageOrder,
  refreshMs: LANGUAGE_REFRESH_MS,
});
const presentationMenu = staticMenu(config.presentationLanguages);
const presentationLogDir = process.env['PRESENTATION_LOG_DIR'];
if (config.presentationMode && presentationLogDir) {
  openPresentationLogs(presentationLogDir, config.publicBaseUrl);
}
if (!config.presentationMode) {
  registry.start();
}

// Recorded prompts. Missing or broken files are not fatal: those lines are
// spoken by Twilio <Say> instead, exactly as before recordings existed.
let prompts = PromptLibrary.empty;
if (config.promptsDir !== undefined) {
  try {
    prompts = PromptLibrary.load(config.promptsDir, (id, reason) =>
      log('prompts.skipped', { id, reason }),
    );
  } catch (error) {
    log('prompts.unavailable', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

const server = await createTelephonyServer({
  config,
  target,
  menu: () => (config.presentationMode ? presentationMenu : registry.menu),
  ...(access === undefined ? {} : { access }),
  prompts,
  companies,
  ...(rest === undefined ? {} : { rest }),
});
log('telephony.listening', {
  port: server.port,
  presentationMode: config.presentationMode,
  fourPoints: config.fourPointsUrl,
  auth: config.fourPointsAuth.mode,
  organizationLine: access !== undefined,
  companyNumbers: COMPANIES.length,
  humanRelay: rest !== undefined && config.humanRelay === 'company',
  maxCalls: config.maxCalls,
  recordedPrompts: prompts.size,
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

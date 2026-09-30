import type { VadConfig } from './vad.js';

/** Silence that ends a caller's turn unless VAD_HANGOVER_MS overrides it. */
export const PHONE_HANGOVER_MS = 1150;

export type FourPointsAuthConfig =
  | { mode: 'none' }
  | {
      mode: 'client-credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope: string;
    };

export interface TelephonyConfig {
  port: number;
  /** Public https origin Twilio calls, e.g. https://phone.example.com */
  publicBaseUrl: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  validateSignatures: boolean;
  fourPointsUrl: string;
  fourPointsAuth: FourPointsAuthConfig;
  clinicianLanguageId: string;
  menuLanguageOrder: string[];
  /** languageId → E.164 numbers; always contains "default". */
  humanNumbers: Record<string, string[]>;
  /** Rate declared to FourPoints in turn.start (16000 = the browser's contract). */
  inputSampleRateHz: 8000 | 16000;
  /** Concurrent AI media streams on this instance. */
  maxCalls: number;
  sessionRotateAfterMs: number;
  vad: Partial<VadConfig>;
  /**
   * Presentation mode: the IVR runs on the real number, but instead of
   * streaming to FourPoints or dialing interpreters it announces where the
   * call would be routed. No FourPoints or interpreter numbers are needed.
   */
  presentationMode: boolean;
  /** Language names read in the presentation-mode menu, in order. */
  presentationLanguages: string[];
}

const DEFAULT_PRESENTATION_LANGUAGES = [
  'Spanish',
  'Mandarin',
  'Arabic',
  'French',
  'Portuguese',
];

const E164 = /^\+[1-9]\d{6,14}$/;
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

export function loadConfig(
  env: Record<string, string | undefined>,
): TelephonyConfig {
  const problems: string[] = [];
  const production = env['NODE_ENV'] === 'production';

  const read = (name: string, fallback?: string): string => {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') {
      return value;
    }
    if (fallback === undefined) {
      problems.push(`${name} is required`);
      return '';
    }
    return fallback;
  };

  const integer = (name: string, fallback: number, min: number): number => {
    const raw = read(name, String(fallback));
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      problems.push(`${name} must be an integer >= ${min}`);
    }
    return value;
  };

  const port = integer('PORT', 8080, 0);

  const publicBaseUrl = read('PUBLIC_BASE_URL').replace(/\/+$/, '');
  if (publicBaseUrl !== '') {
    let url: URL | undefined;
    try {
      url = new URL(publicBaseUrl);
    } catch {
      problems.push('PUBLIC_BASE_URL must be a URL');
    }
    if (url !== undefined && (url.pathname !== '/' || url.search !== '')) {
      problems.push('PUBLIC_BASE_URL must be an origin with no path or query');
    }
    if (url !== undefined && production && url.protocol !== 'https:') {
      problems.push('PUBLIC_BASE_URL must use https in production');
    }
  }

  const twilioAccountSid = read('TWILIO_ACCOUNT_SID');
  if (twilioAccountSid !== '' && !ACCOUNT_SID.test(twilioAccountSid)) {
    problems.push(
      'TWILIO_ACCOUNT_SID must look like AC followed by 32 hex characters',
    );
  }
  const twilioAuthToken = read('TWILIO_AUTH_TOKEN');

  const validateSignatures =
    read('TWILIO_VALIDATE_SIGNATURES', 'true') !== 'false';
  if (!validateSignatures && production) {
    problems.push('TWILIO_VALIDATE_SIGNATURES=false is refused in production');
  }

  const fourPointsUrl = read('FOURPOINTS_WS_URL', 'ws://localhost:8787');
  if (production && !fourPointsUrl.startsWith('wss://')) {
    problems.push('FOURPOINTS_WS_URL must use wss:// in production');
  }

  const authMode = read('FOURPOINTS_AUTH', 'none');
  let fourPointsAuth: FourPointsAuthConfig = { mode: 'none' };
  if (authMode === 'client-credentials') {
    fourPointsAuth = {
      mode: 'client-credentials',
      tokenUrl: read('FOURPOINTS_TOKEN_URL'),
      clientId: read('FOURPOINTS_CLIENT_ID'),
      clientSecret: read('FOURPOINTS_CLIENT_SECRET'),
      scope: read('FOURPOINTS_SCOPE'),
    };
  } else if (authMode !== 'none') {
    problems.push('FOURPOINTS_AUTH must be "none" or "client-credentials"');
  } else if (production) {
    problems.push('FOURPOINTS_AUTH=none is refused in production');
  }

  const presentationMode = read('PRESENTATION_MODE', 'false') === 'true';
  const presentationLanguages = read('PRESENTATION_LANGUAGES', '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (presentationLanguages.length > 9) {
    problems.push('PRESENTATION_LANGUAGES must list at most 9 languages');
  }

  const humanNumbers: Record<string, string[]> = {};
  try {
    const parsed: unknown = JSON.parse(read('HUMAN_INTERPRETER_NUMBERS', '{}'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('not an object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      const numbers = Array.isArray(value) ? value : [value];
      if (
        numbers.length === 0 ||
        numbers.length > 10 ||
        !numbers.every((n) => typeof n === 'string' && E164.test(n))
      ) {
        problems.push(
          `HUMAN_INTERPRETER_NUMBERS["${key}"] must be 1-10 E.164 numbers`,
        );
        continue;
      }
      humanNumbers[key] = numbers as string[];
    }
    // Simple form: HUMAN_INTERPRETER_NUMBER=+15551234567[,+15557654321]
    const simple = read('HUMAN_INTERPRETER_NUMBER', '')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '');
    if (simple.length > 0) {
      if (simple.length > 10 || !simple.every((n) => E164.test(n))) {
        problems.push(
          'HUMAN_INTERPRETER_NUMBER must be 1-10 numbers in +15551234567 format, comma-separated',
        );
      } else {
        humanNumbers['default'] = simple;
      }
    }
    if (humanNumbers['default'] === undefined && !presentationMode) {
      problems.push('HUMAN_INTERPRETER_NUMBERS must include a "default" entry');
    }
  } catch {
    problems.push('HUMAN_INTERPRETER_NUMBERS must be a JSON object');
  }

  const rate = integer('INPUT_SAMPLE_RATE_HZ', 16000, 1);
  if (rate !== 8000 && rate !== 16000) {
    problems.push('INPUT_SAMPLE_RATE_HZ must be 8000 or 16000');
  }

  const vad: Partial<VadConfig> = {};
  const minRms = env['VAD_MIN_RMS'];
  if (minRms !== undefined && minRms !== '') {
    const value = Number(minRms);
    if (!(value > 0 && value < 1)) {
      problems.push('VAD_MIN_RMS must be between 0 and 1');
    }
    vad.minRms = value;
  }
  // Callers pause mid-thought ("uh…"); the shared 900 ms default cut turns
  // short on the phone, so the gateway waits longer before ending a turn.
  const hangoverMs = integer('VAD_HANGOVER_MS', PHONE_HANGOVER_MS, 1);
  if (hangoverMs < 300 || hangoverMs > 10_000) {
    problems.push('VAD_HANGOVER_MS must be between 300 and 10000');
  }
  vad.hangoverMs = hangoverMs;

  const config: TelephonyConfig = {
    port,
    publicBaseUrl,
    twilioAccountSid,
    twilioAuthToken,
    validateSignatures,
    fourPointsUrl,
    fourPointsAuth,
    clinicianLanguageId: read('CLINICIAN_LANGUAGE_ID', 'en-US'),
    menuLanguageOrder: read('MENU_LANGUAGE_ORDER', '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
    humanNumbers,
    inputSampleRateHz: rate === 8000 ? 8000 : 16000,
    maxCalls: integer('MAX_CALLS', 20, 1),
    sessionRotateAfterMs: integer(
      'SESSION_ROTATE_AFTER_MS',
      28 * 60_000,
      60_000,
    ),
    vad,
    presentationMode,
    presentationLanguages:
      presentationLanguages.length > 0
        ? presentationLanguages
        : DEFAULT_PRESENTATION_LANGUAGES,
  };

  if (problems.length > 0) {
    throw new Error(
      `Invalid telephony configuration:\n  - ${problems.join('\n  - ')}`,
    );
  }
  return config;
}

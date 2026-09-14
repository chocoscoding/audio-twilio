/**
 * The whole demo in one command:
 *
 *   browser phone ─► Twilio emulator (:3000) ─► telephony gateway (:8080) ─► FourPoints stand-in (:8787)
 *
 * The gateway is the real, unchanged apps/telephony build, started as its own
 * process with signature validation on. Only Twilio and FourPoints are
 * replaced. Optional settings: apps/telephony-demo/.env (see .env.example).
 *
 *   npm run build && npm run demo          then open http://localhost:3000
 *   npm run demo:check                     pre-flight check, in a second terminal
 *   npm run demo:stand-in                  stand-in only, for a real Twilio call
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { startEmulator, type Emulator } from './emulator.js';
import { APP_DIR, ENV_FILE_LOADED, PORTS, STAND_IN_HOST } from './settings.js';
import { startStandIn, type DemoScript } from './stand-in.js';
import { SPEECH_RATE_HZ, parseWav, toSpeechRate, trimSilence } from './wav.js';

type SpeechSource = 'recording' | 'placeholder' | 'missing' | 'never spoken';

const GATEWAY_ENTRY = join(APP_DIR, '..', 'telephony', 'dist', 'index.js');
const TWILIO_NUMBER = '+15555550123';
const CALLER_NUMBER = '+15555550199';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Your recordings win; otherwise the generated placeholder; otherwise a short silence. */
function loadSpeech(script: DemoScript) {
  const speech = new Map<string, Int16Array>();
  const sources: Record<string, SpeechSource> = {};
  for (const line of script.lines) {
    sources[line.id] =
      line.gate?.status === 'FAIL' ? 'never spoken' : 'missing';
    if (line.gate?.status === 'FAIL') {
      continue;
    }
    for (const [source, dir] of [
      ['recording', 'recordings'],
      ['placeholder', 'placeholders'],
    ] as const) {
      const file = join(APP_DIR, dir, `${line.id}.wav`);
      if (!existsSync(file)) {
        continue;
      }
      try {
        const pcm = toSpeechRate(parseWav(readFileSync(file)));
        speech.set(line.id, trimSilence(pcm, SPEECH_RATE_HZ));
        sources[line.id] = source;
        break;
      } catch (error) {
        console.warn(
          `  ! ${dir}/${line.id}.wav: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  return { speech, sources };
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) {
        return true;
      }
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  return false;
}

const waitForStopSignal = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });

const script = JSON.parse(
  readFileSync(join(APP_DIR, 'script.json'), 'utf8'),
) as DemoScript;
const { speech, sources } = loadSpeech(script);

console.log(`\n${script.title}`);
if (ENV_FILE_LOADED) {
  console.log('  Settings: apps/telephony-demo/.env');
}
for (const line of script.lines) {
  console.log(`  ${line.id.padEnd(30)} ${sources[line.id]}`);
}
if (Object.values(sources).includes('missing')) {
  console.log(
    '  Missing speech plays as silence. Run `npm run demo:placeholders` or add recordings.',
  );
}

let emulator: Emulator | undefined;

let standIn;
try {
  standIn = await startStandIn({
    port: PORTS.fourPoints,
    host: STAND_IN_HOST,
    script,
    speech,
    onEvent: (event) => emulator?.broadcast({ source: 'fourpoints', ...event }),
  });
} catch (error) {
  console.error(
    `\nCould not start the FourPoints stand-in on port ${PORTS.fourPoints} ` +
      `(${error instanceof Error ? error.message : error}). Is a local FourPoints running? ` +
      'Stop it, or set DEMO_FOURPOINTS_PORT in apps/telephony-demo/.env.',
  );
  process.exit(1);
}
console.log(`\nFourPoints stand-in    ws://${STAND_IN_HOST}:${standIn.port}`);

if (process.argv.includes('--stand-in-only')) {
  console.log(
    'Stand-in only. Point a gateway at it with FOURPOINTS_WS_URL=ws://<this host>:' +
      `${standIn.port} and FOURPOINTS_AUTH=none. Ctrl+C to stop.`,
  );
  await waitForStopSignal();
  await standIn.close();
  process.exit(0);
}

if (!existsSync(GATEWAY_ENTRY)) {
  console.error('\nThe gateway is not built. Run `npm run build` first.');
  await standIn.close();
  process.exit(1);
}

// A fresh Twilio identity per run; the token stays in this process and the
// gateway. Set both variables to fix it (e.g. to drive the gateway with the
// fake-twilio-call harness).
const accountSid =
  process.env['DEMO_TWILIO_ACCOUNT_SID'] ||
  `AC${randomBytes(16).toString('hex')}`;
const authToken =
  process.env['DEMO_TWILIO_AUTH_TOKEN'] || randomBytes(24).toString('hex');
const gatewayBaseUrl = `http://localhost:${PORTS.gateway}`;

const gateway = spawn(process.execPath, [GATEWAY_ENTRY], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORTS.gateway),
    PUBLIC_BASE_URL: gatewayBaseUrl,
    TWILIO_ACCOUNT_SID: accountSid,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_VALIDATE_SIGNATURES: 'true',
    FOURPOINTS_WS_URL: `ws://127.0.0.1:${standIn.port}`,
    FOURPOINTS_AUTH: 'none',
    CLINICIAN_LANGUAGE_ID: script.clinicianLanguageId,
    INPUT_SAMPLE_RATE_HZ: '16000',
    HUMAN_INTERPRETER_NUMBERS: JSON.stringify({
      default: ['+15555550100'],
      [script.patientLanguageId]: ['+15555550101', '+15555550102'],
    }),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

createInterface({ input: gateway.stdout }).on('line', (text) => {
  try {
    const entry = JSON.parse(text) as { event?: string };
    console.log(`  [gateway] ${text}`);
    emulator?.broadcast({
      source: 'gateway',
      kind: 'log',
      event: entry.event ?? 'log',
      detail: entry,
    });
  } catch {
    console.log(`  [gateway] ${text}`);
  }
});

const shutdown = async (code: number) => {
  gateway.removeAllListeners('exit');
  gateway.kill();
  await emulator?.close();
  await standIn.close();
  process.exit(code);
};

gateway.on('exit', (code) => {
  console.error(
    `\nThe gateway exited (code ${code}). If port ${PORTS.gateway} is in use, ` +
      'set DEMO_GATEWAY_PORT in apps/telephony-demo/.env.',
  );
  void shutdown(1);
});

if (!(await waitForHealth(`${gatewayBaseUrl}/healthz`, 10_000))) {
  console.error('\nThe gateway did not become healthy.');
  await shutdown(1);
}
console.log(
  `Telephony gateway      ${gatewayBaseUrl}  (unchanged build, signatures enforced)`,
);

try {
  emulator = await startEmulator({
    port: PORTS.web,
    gatewayBaseUrl,
    accountSid,
    authToken,
    callerNumber: CALLER_NUMBER,
    twilioNumber: TWILIO_NUMBER,
    pageHtml: readFileSync(join(APP_DIR, 'public', 'phone.html'), 'utf8'),
    pageData: {
      script,
      accountSid,
      gatewayBaseUrl,
      twilioNumber: TWILIO_NUMBER,
      sources,
    },
  });
} catch (error) {
  console.error(
    `\nCould not start the demo page on port ${PORTS.web} ` +
      `(${error instanceof Error ? error.message : error}). ` +
      'Set DEMO_WEB_PORT in apps/telephony-demo/.env.',
  );
  await shutdown(1);
}
console.log(
  `Twilio emulator + phone http://localhost:${emulator?.port ?? PORTS.web}\n\n` +
    'Pre-flight check (second terminal): npm run demo:check\nCtrl+C to stop.',
);

await waitForStopSignal();
await shutdown(0);

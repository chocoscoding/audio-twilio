#!/usr/bin/env node
/**
 * One-command presentation on a real Twilio number (macOS / Linux):
 *
 *   npm run present
 *
 * 1. Opens a public HTTPS tunnel to the gateway (cloudflared quick tunnel, no
 *    account needed) — or uses `--url https://your.domain` if you have one.
 * 2. Points TWILIO_PHONE_NUMBER's "A call comes in" webhook at the tunnel.
 * 3. Starts the gateway with PUBLIC_BASE_URL set to the tunnel.
 *
 * Reads apps/telephony/.env. Ctrl+C stops everything.
 */

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import { Resolver } from 'node:dns';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URLSearchParams } from 'node:url';

const { fetch } = globalThis;

const root = resolve(import.meta.dirname, '..');
const envFile = resolve(root, 'apps/telephony/.env');
const gatewayEntry = resolve(root, 'apps/telephony/dist/index.js');
const logDir = resolve(root, 'logs');

const fail = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};
const ok = (message) => console.log(`✓ ${message}`);

if (!existsSync(envFile)) {
  fail(
    'apps/telephony/.env is missing. Run: cp apps/telephony/.env.presentation.example apps/telephony/.env',
  );
}
process.loadEnvFile(envFile);
if (!existsSync(gatewayEntry)) {
  fail('The gateway is not built. Run: npm run build');
}

const env = process.env;
const sid = env.TWILIO_ACCOUNT_SID ?? '';
const token = env.TWILIO_AUTH_TOKEN ?? '';
const phoneNumber = (env.TWILIO_PHONE_NUMBER ?? '').replace(/[\s()-]/g, '');
const port = Number(env.PORT || 8080);

if (!/^AC[0-9a-f]{32}$/.test(sid)) {
  fail('Set TWILIO_ACCOUNT_SID in apps/telephony/.env (starts with AC).');
}
if (token === '' || token === 'replace-me') {
  fail('Set TWILIO_AUTH_TOKEN in apps/telephony/.env.');
}
if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
  fail('Set TWILIO_PHONE_NUMBER in apps/telephony/.env, e.g. +15551234567.');
}

// Check the port before touching Twilio, so a second copy never re-points
// the number at a gateway that cannot start.
const portFree = await new Promise((resolvePort) => {
  const probe = createServer()
    .once('error', () => resolvePort(false))
    .once('listening', () => probe.close(() => resolvePort(true)))
    .listen(port);
});
if (!portFree) {
  fail(
    `Port ${port} is already in use — is \`npm run present\` already running in another terminal? Stop it with Ctrl+C first.`,
  );
}

const children = [];
const stopAll = () => {
  for (const child of children) {
    child.kill('SIGTERM');
  }
};
process.on('SIGINT', () => {
  console.log(
    '\nStopping… Calls to your number will FAIL (Twilio error 11200 / HTTP 530)\n' +
      'until you run `npm run present` again — the tunnel address closes with it.',
  );
  stopAll();
  setTimeout(() => process.exit(0), 1500).unref();
});

// --- 1. Public URL -----------------------------------------------------------
const urlFlag = process.argv.indexOf('--url');
let publicUrl =
  urlFlag === -1 ? undefined : process.argv[urlFlag + 1]?.replace(/\/+$/, '');

if (publicUrl === undefined) {
  if (spawnSync('which', ['cloudflared']).status !== 0) {
    fail('cloudflared is not installed. Run: brew install cloudflared');
  }
  // Free quick tunnels fail now and then (rate limits, slow API); retry.
  const openTunnel = () =>
    new Promise((resolveTunnel) => {
      const tunnel = spawn(
        'cloudflared',
        ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      const done = (result) => {
        clearTimeout(timer);
        resolveTunnel(result);
      };
      const timer = setTimeout(() => {
        tunnel.kill('SIGTERM');
        done({ error: 'no URL within 30 s', output });
      }, 30_000);
      const onData = (chunk) => {
        output = (output + chunk.toString()).slice(-4000);
        const match = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(
          output,
        );
        if (match) {
          done({ url: match[0], tunnel });
        }
      };
      tunnel.stdout.on('data', onData);
      tunnel.stderr.on('data', onData);
      tunnel.on('exit', (code) =>
        done({ error: `cloudflared exited (code ${code})`, output }),
      );
    });

  for (let attempt = 1; publicUrl === undefined; attempt++) {
    console.log(
      `… opening a public tunnel (cloudflared, attempt ${attempt}/3)`,
    );
    const result = await openTunnel();
    if (result.url !== undefined) {
      children.push(result.tunnel);
      result.tunnel.on('exit', () => {
        console.log(
          '\n✗ The tunnel (cloudflared) stopped — calls will fail. Press Ctrl+C and run `npm run present` again.',
        );
      });
      publicUrl = result.url;
      break;
    }
    const reason = result.output
      .split('\n')
      .filter((line) => /ERR|error|failed|429|1015/i.test(line))
      .slice(-3)
      .join('\n  ');
    console.log(`  ${result.error}${reason ? `:\n  ${reason}` : ''}`);
    if (attempt === 3) {
      fail(
        'Could not open a tunnel after 3 attempts. Wait a minute (Cloudflare limits\n' +
          '  free tunnels) and run `npm run present` again.',
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
if (!publicUrl.startsWith('https://')) {
  fail('--url must be an https:// origin.');
}
ok(`Public URL  ${publicUrl}`);

// --- 2. Point the Twilio number at it ---------------------------------------
const api = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
const lookup = await fetch(
  `${api}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
  { headers: { authorization: auth } },
);
if (lookup.status === 401) {
  stopAll();
  fail('Twilio rejected the Account SID / Auth Token.');
}
const found = (await lookup.json()).incoming_phone_numbers?.[0];
if (found === undefined) {
  stopAll();
  fail(`${phoneNumber} is not a number on account ${sid}.`);
}
const voiceUrl = `${publicUrl}/voice/incoming`;
const update = await fetch(`${api}/IncomingPhoneNumbers/${found.sid}.json`, {
  method: 'POST',
  headers: {
    authorization: auth,
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    VoiceUrl: voiceUrl,
    VoiceMethod: 'POST',
    StatusCallback: `${publicUrl}/voice/status`,
    StatusCallbackMethod: 'POST',
  }),
});
if (!update.ok) {
  stopAll();
  fail(`Could not update the number's webhook: ${await update.text()}`);
}
ok(`Twilio      ${phoneNumber} → ${voiceUrl}`);
if (found.voice_url && found.voice_url !== voiceUrl) {
  console.log(`  (previous webhook was ${found.voice_url})`);
}

// --- 3. Gateway ----------------------------------------------------------------
// Readable logs go to logs/twilio.log and logs/stream.log; the gateway's raw
// JSON log lines go to logs/gateway.jsonl for debugging.
mkdirSync(logDir, { recursive: true });
const gateway = spawn(process.execPath, [gatewayEntry], {
  env: {
    ...env,
    PUBLIC_BASE_URL: publicUrl,
    PRESENTATION_MODE: env.PRESENTATION_MODE ?? 'true',
    PRESENTATION_LOG_DIR: logDir,
  },
  stdio: ['ignore', openSync(resolve(logDir, 'gateway.jsonl'), 'w'), 'inherit'],
});
children.push(gateway);
gateway.on('exit', (code) => {
  stopAll();
  if (code !== 0 && code !== null) {
    fail(`The gateway exited (code ${code}). See the message above.`);
  }
  process.exit(0);
});

// --- 4. Wait until Twilio can actually reach it --------------------------------
// Resolve through public DNS, as Twilio does. Home routers often cache
// "not found" for a brand-new tunnel name for minutes, which would make a
// working tunnel look broken from this Mac.
const publicDns = new Resolver();
publicDns.setServers(['1.1.1.1', '8.8.8.8']);
const publicLookup = (hostname, options, callback) =>
  publicDns.resolve4(hostname, (error, addresses) =>
    error
      ? callback(error)
      : options.all
        ? callback(
            null,
            addresses.map((address) => ({ address, family: 4 })),
          )
        : callback(null, addresses[0], 4),
  );
const healthy = () =>
  new Promise((resolveHealth) => {
    const request = httpsGet(
      `${publicUrl}/healthz`,
      { lookup: publicLookup, timeout: 5000 },
      (res) => {
        res.resume();
        resolveHealth(res.statusCode === 200);
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolveHealth(false));
  });

const deadline = Date.now() + 60_000;
let reachable = false;
while (!(reachable = await healthy()) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
}
if (reachable) {
  ok('Reachable   the gateway answers through the tunnel');
} else {
  console.log(
    `! Could not confirm ${publicUrl} from this Mac within 60 s.\n` +
      '  Still running — place a test call. If Twilio reports error 11200,\n' +
      '  press Ctrl+C and run `npm run present` again.',
  );
}
console.log(
  `\n  READY — call ${phoneNumber}\n\n` +
    '  This terminal now shows the TWILIO log (webhooks + TwiML).\n' +
    '  In a second terminal run:  npm run logs:stream\n' +
    '  Ctrl+C to stop.\n',
);

// --- 5. Terminal 1 follows the Twilio log ------------------------------------
const follow = spawn(
  'tail',
  ['-n', '+1', '-F', resolve(logDir, 'twilio.log')],
  {
    stdio: ['ignore', 'inherit', 'ignore'],
  },
);
children.push(follow);

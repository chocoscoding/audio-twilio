/**
 * Pre-flight check before presenting. With `npm run demo` running, it places
 * one call along the browser phone's exact path — signed webhooks through the
 * Twilio emulator, the media stream relay, the real gateway and the FourPoints
 * stand-in — and reports each hop. Nothing is played aloud.
 *
 *   npm run demo:check
 */

import WebSocket from 'ws';

import { PORTS } from './settings.js';

const WEB = `http://127.0.0.1:${PORTS.web}`;
const FRAME_BYTES = 160; // 20 ms of μ-law at 8 kHz, as Twilio sends
const SILENCE = new Uint8Array(FRAME_BYTES).fill(0xff);

interface DemoInfo {
  accountSid: string;
  gatewayBaseUrl: string;
  script: { clinicianLanguageId: string };
}

class CheckFailed extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pass(ok: boolean, text: string, hint: string): void {
  if (!ok) {
    console.log(`✗ ${text}\n    ${hint}`);
    throw new CheckFailed(text);
  }
  console.log(`✓ ${text}`);
}

async function waitUntil(
  done: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(50);
  }
  return true;
}

function linearToMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(sample), 32635) + 0x84;
  let exponent = 7;
  for (
    let mask = 0x4000;
    (magnitude & mask) === 0 && exponent > 0;
    mask >>= 1
  ) {
    exponent--;
  }
  return (
    ~(sign | (exponent << 4) | ((magnitude >> (exponent + 3)) & 0x0f)) & 0xff
  );
}

/** 20 ms of a 440 Hz tone: loud enough to count as speech; the script ignores content. */
function toneFrame(offset: number): Uint8Array {
  const frame = new Uint8Array(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i++) {
    frame[i] = linearToMulaw(
      Math.round(
        0.3 * 32767 * Math.sin((2 * Math.PI * 440 * (offset + i)) / 8000),
      ),
    );
  }
  return frame;
}

async function webhook(url: string, params: Record<string, string> = {}) {
  const res = await fetch(`${WEB}/twilio/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, callSid: 'CApreflight', params }),
  });
  return { status: res.status, twiml: await res.text() };
}

const actionOf = (twiml: string) =>
  /action="([^"]+)"/.exec(twiml)?.[1]?.replaceAll('&amp;', '&') ?? '';

async function run(): Promise<void> {
  let demo: DemoInfo;
  try {
    demo = (await (await fetch(`${WEB}/demo.json`)).json()) as DemoInfo;
  } catch {
    pass(
      false,
      `Demo running at ${WEB}`,
      'Start it with `npm run demo` and wait for the "Twilio emulator + phone" line.',
    );
    return;
  }
  console.log(`Checking the demo at ${WEB}\n`);

  const welcome = await webhook(`${demo.gatewayBaseUrl}/voice/incoming`);
  pass(
    welcome.status === 200 && welcome.twiml.includes('<Gather'),
    'Gateway accepted a Twilio-signed webhook and returned the welcome menu',
    'Look for [gateway] errors in the demo terminal, then restart `npm run demo`.',
  );

  const menu = await webhook(actionOf(welcome.twiml), { Digits: '1' });
  const firstLanguage = /For (.+?), press 1\./.exec(menu.twiml)?.[1];
  pass(
    menu.status === 200 && firstLanguage !== undefined,
    `Language menu read from the FourPoints stand-in (press 1 = ${firstLanguage ?? 'none'})`,
    'The gateway has no languages yet. Wait a few seconds and run the check again.',
  );

  const connect = await webhook(actionOf(menu.twiml), { Digits: '1' });
  const streamUrl = /<Stream url="([^"]+)"/.exec(connect.twiml)?.[1];
  const patient = /name="patientLanguageId" value="([^"]+)"/.exec(
    connect.twiml,
  )?.[1];
  pass(
    connect.status === 200 && streamUrl !== undefined && patient !== undefined,
    'AI interpreter chosen: the gateway answered with a media stream',
    'The gateway did not return <Connect><Stream>. Check the demo terminal.',
  );

  const ws = new WebSocket(
    `${WEB.replace(/^http/, 'ws')}/twilio/media?url=${encodeURIComponent(streamUrl ?? '')}`,
  );
  const opened = await new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('error', () => resolve(false));
  });
  pass(
    opened,
    'Media stream opened through the emulator with a signed handshake',
    'The emulator could not open the gateway /media endpoint. Restart `npm run demo`.',
  );

  let receivedBytes = 0;
  let playedMarks = 0;
  let playoutEndsAt = 0;
  const outgoing: Uint8Array[] = [];
  const send = (message: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ streamSid: 'MZpreflight', ...message }));
    }
  };
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      event?: string;
      media?: { payload: string };
      mark?: { name: string };
    };
    if (message.event === 'media' && message.media !== undefined) {
      const bytes = Buffer.from(message.media.payload, 'base64').length;
      receivedBytes += bytes;
      playoutEndsAt = Math.max(Date.now(), playoutEndsAt) + bytes / 8;
    } else if (message.event === 'mark' && message.mark !== undefined) {
      const mark = message.mark;
      // Like Twilio: echo the mark once the audio queued before it has "played".
      setTimeout(
        () => {
          send({ event: 'mark', mark });
          playedMarks += 1;
        },
        Math.max(0, playoutEndsAt - Date.now()),
      );
    }
  });

  send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  send({
    event: 'start',
    start: {
      accountSid: demo.accountSid,
      streamSid: 'MZpreflight',
      callSid: 'CApreflight',
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: {
        clinicianLanguageId: demo.script.clinicianLanguageId,
        patientLanguageId: patient,
      },
    },
  });
  const ticker = setInterval(() => {
    const frame = outgoing.shift() ?? SILENCE;
    send({
      event: 'media',
      media: {
        track: 'inbound',
        payload: Buffer.from(frame).toString('base64'),
      },
    });
  }, 20);

  try {
    pass(
      await waitUntil(() => playedMarks >= 1, 10_000),
      'Gateway opened a FourPoints session and played the clinician tone',
      'No tone within 10 seconds. Check the [gateway] lines in the demo terminal.',
    );
    await sleep(1_000); // handoff guard + speech-detector calibration
    for (let i = 0; i < 30; i++) {
      outgoing.push(toneFrame(i * FRAME_BYTES)); // 600 ms of "speech"
    }
    const before = receivedBytes;
    const answered = await waitUntil(() => playedMarks >= 2, 30_000);
    pass(
      answered,
      'Speech detected, turn sent to the stand-in and answered',
      'The turn was never answered. Check the demo terminal for errors.',
    );
    const seconds = (receivedBytes - before) / 8000;
    pass(
      seconds > 0.4,
      `Translated speech played back (${seconds.toFixed(1)} s)`,
      'Only silence came back. Run `npm run demo:placeholders` or add recordings, then restart the demo.',
    );
    pass(
      await waitUntil(() => playedMarks >= 3, 5_000),
      'Floor handed to the patient (high tone)',
      'No hand-over tone. Check the demo terminal.',
    );
  } finally {
    clearInterval(ticker);
    send({ event: 'stop', stop: {} });
    ws.close();
  }
  console.log(`\nReady to present: open http://localhost:${PORTS.web}`);
}

try {
  await run();
  process.exit(0);
} catch (error) {
  if (!(error instanceof CheckFailed)) {
    console.log(`✗ ${error instanceof Error ? error.message : error}`);
  }
  console.log(
    '\nNot ready. Fix the item above and run `npm run demo:check` again.',
  );
  process.exit(1);
}

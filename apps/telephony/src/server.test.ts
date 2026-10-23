/**
 * End to end, in process: a fake Twilio caller → the real gateway → a fake
 * FourPoints server speaking protocol v1 exactly as apps/realtime does.
 */

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import {
  PROTOCOL_VERSION,
  decodeAudioFrame,
  encodeTtsAudioFrame,
  parseClientMessage,
  type ServerMessage,
  type TurnMetrics,
  type WireLanguageCapability,
} from '@fourpoints/protocol';

import { CUES, encodeMulaw } from './audio.js';
import { createAuthHeaders } from './auth.js';
import { loadConfig, type TelephonyConfig } from './config.js';
import { fetchLanguages, type FourPointsTarget } from './fourpoints.js';
import { LanguageRegistry } from './languages.js';
import { PromptLibrary } from './prompts.js';
import { createTelephonyServer, type TelephonyServer } from './server.js';
import { twilioSignature } from './twilio-signature.js';

const TOKEN = 'test-auth-token';
const ACCOUNT_SID = `AC${'1'.repeat(32)}`;
const PUBLIC_BASE_URL = 'http://gateway.test';

const voice = (languageId: string): WireLanguageCapability => ({
  languageId,
  displayName: languageId,
  input: { speech: true, text: true },
  output: { speech: true, text: true },
  capabilityTier: 'FULL_VOICE',
  validationStatus: 'DEMO_VALIDATED',
});

interface FakeFourPoints {
  url: string;
  turns: {
    speaker: string;
    sampleRateHz: number;
    samples: number;
    detectLanguage?: boolean | undefined;
  }[];
  authorization: (string | undefined)[];
  userAgent: (string | undefined)[];
  close(): Promise<void>;
}

/** `sessionDelayMs`: how long FourPoints takes to answer session.start. */
async function startFakeFourPoints(
  sessionDelayMs = 0,
): Promise<FakeFourPoints> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const fake: FakeFourPoints = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    turns: [],
    authorization: [],
    userAgent: [],
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
  wss.on('connection', (ws, req) => {
    fake.authorization.push(req.headers.authorization);
    fake.userAgent.push(req.headers['user-agent']);
    let turn: FakeFourPoints['turns'][number] | undefined;
    const send = (message: ServerMessage) => ws.send(JSON.stringify(message));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodeAudioFrame(new Uint8Array(data as Buffer));
        if (turn !== undefined && frame !== null) {
          turn.samples += frame.samples.length;
        }
        return;
      }
      const message = parseClientMessage(data.toString());
      switch (message?.type) {
        case 'session.start':
          setTimeout(() => {
            send({
              type: 'session.ready',
              protocolVersion: PROTOCOL_VERSION,
              sessionId: 's1',
            });
            send({
              type: 'languages.available',
              languages: [voice('en-US'), voice('es-US')],
              defaultClinicianLanguageId: 'en-US',
              defaultPatientLanguageId: 'es-US',
            });
          }, sessionDelayMs);
          break;
        case 'conversation.start':
          send({ type: 'conversation.ready', conversationId: 'c1' });
          send({
            type: 'conversation.languages',
            conversationId: 'c1',
            clinicianLanguageId: message.clinicianLanguageId,
            patientLanguageId: message.patientLanguageId,
          });
          break;
        case 'turn.start':
          turn = {
            speaker: message.speaker,
            sampleRateHz: message.audioFormat.sampleRateHz,
            samples: 0,
            detectLanguage: message.detectLanguage,
          };
          fake.turns.push(turn);
          send({ type: 'listening', turnId: 't1' });
          break;
        case 'turn.end': {
          // 200 ms of 16 kHz "translated speech".
          const pcm = Int16Array.from({ length: 3200 }, (_, i) =>
            Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)),
          );
          send({
            type: 'tts.started',
            turnId: 't1',
            audioFormat: {
              encoding: 'pcm_s16le',
              sampleRateHz: 16000,
              channels: 1,
            },
          });
          ws.send(
            encodeTtsAudioFrame({
              sequence: 0,
              timestampMs: Date.now(),
              payload: new Uint8Array(pcm.buffer),
            }),
          );
          send({ type: 'tts.ended', turnId: 't1' });
          send({
            type: 'metrics.turn',
            turnId: 't1',
            metrics: {} as TurnMetrics,
          });
          break;
        }
        case 'session.end':
          ws.close(1000);
          break;
        default:
          break;
      }
    });
  });
  return fake;
}

function baseConfig(fourPointsUrl: string): TelephonyConfig {
  return loadConfig({
    PORT: '0',
    PUBLIC_BASE_URL,
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: TOKEN,
    FOURPOINTS_WS_URL: fourPointsUrl,
    HUMAN_INTERPRETER_NUMBERS: '{"default":["+15550000001"]}',
  });
}

/** 20 ms of μ-law at 8 kHz: a tone for speech, digital silence otherwise. */
function mulawFrame(speech: boolean, offset: number): string {
  const pcm = Int16Array.from({ length: 160 }, (_, i) =>
    speech
      ? Math.round(
          0.3 * 32767 * Math.sin((2 * Math.PI * 440 * (offset + i)) / 8000),
        )
      : 0,
  );
  return Buffer.from(encodeMulaw(pcm)).toString('base64');
}

describe('telephony gateway (integration)', () => {
  let fake: FakeFourPoints;
  let gateway: TelephonyServer;
  let target: FourPointsTarget;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fake = await startFakeFourPoints();
    const config = baseConfig(fake.url);
    target = {
      url: config.fourPointsUrl,
      authHeaders: createAuthHeaders(config.fourPointsAuth),
    };
    const registry = new LanguageRegistry({
      fetchLanguages: () => fetchLanguages(target),
      clinicianLanguageId: 'en-US',
      order: [],
      refreshMs: 60_000,
    });
    await registry.refresh();
    gateway = await createTelephonyServer({
      config,
      target,
      menu: () => registry.menu,
    });
  });

  afterEach(async () => {
    await gateway.close(0);
    await fake.close();
    vi.restoreAllMocks();
  });

  it('answers signed webhooks and rejects unsigned ones', async () => {
    const url = `http://127.0.0.1:${gateway.port}/voice/incoming`;
    const body = 'CallSid=CA123&From=%2B15550000009';
    const params = new URLSearchParams(body);
    const signed = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature(
          TOKEN,
          `${PUBLIC_BASE_URL}/voice/incoming`,
          params,
        ),
      },
      body,
    });
    expect(signed.status).toBe(200);
    expect(await signed.text()).toContain('<Gather');
    const unsigned = await fetch(url, { method: 'POST', body });
    expect(unsigned.status).toBe(403);
    const health = await fetch(`http://127.0.0.1:${gateway.port}/healthz`);
    expect(await health.json()).toMatchObject({ status: 'ok', activeCalls: 0 });
  });

  it('refuses a media stream without a valid Twilio signature', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/media`);
    ws.on('error', () => undefined); // terminate() below reports the aborted handshake
    const [, res] = (await once(ws, 'unexpected-response')) as [
      unknown,
      { statusCode: number },
    ];
    expect(res.statusCode).toBe(403);
    ws.terminate();
  });

  it('bridges a spoken turn to FourPoints and plays the translation back', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/media`, {
      headers: {
        'x-twilio-signature': twilioSignature(TOKEN, 'ws://gateway.test/media'),
      },
    });
    await once(ws, 'open');

    let receivedBytes = 0;
    const marks: string[] = [];
    let markWaiter: (() => void) | undefined;
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as {
        event: string;
        media?: { payload: string };
        mark?: { name: string };
      };
      if (message.event === 'media' && message.media) {
        receivedBytes += Buffer.from(message.media.payload, 'base64').length;
      }
      if (message.event === 'mark' && message.mark) {
        marks.push(message.mark.name);
        markWaiter?.();
      }
    });
    const nextMark = async (count: number) => {
      while (marks.length < count) {
        await new Promise<void>((resolve) => (markWaiter = resolve));
      }
      // Twilio echoes a mark once its audio has played.
      ws.send(
        JSON.stringify({
          event: 'mark',
          streamSid: 'MZ1',
          mark: { name: marks[count - 1] },
        }),
      );
    };

    ws.send(
      JSON.stringify({
        event: 'connected',
        protocol: 'Call',
        version: '1.0.0',
      }),
    );
    ws.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZ1',
        start: {
          accountSid: ACCOUNT_SID,
          streamSid: 'MZ1',
          callSid: 'CA1',
          tracks: ['inbound'],
          mediaFormat: {
            encoding: 'audio/x-mulaw',
            sampleRate: 8000,
            channels: 1,
          },
          customParameters: {
            clinicianLanguageId: 'en-US',
            patientLanguageId: 'es-US',
          },
        },
      }),
    );

    await nextMark(1); // clinician cue played
    const startedAt = Date.now();
    let offset = 0;
    const stream = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const speech = elapsed > 1000 && elapsed < 1600; // after guard + calibration
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid: 'MZ1',
          media: { track: 'inbound', payload: mulawFrame(speech, offset) },
        }),
      );
      offset += 160;
    }, 20);

    try {
      await nextMark(2); // translated speech played
      await nextMark(3); // floor handed to the patient
    } finally {
      clearInterval(stream);
      ws.close();
    }

    expect(fake.turns).toHaveLength(1);
    expect(fake.turns[0]).toMatchObject({
      speaker: 'clinician',
      sampleRateHz: 16000,
      // LANGID-001: on by default, so FourPoints checks the language heard.
      detectLanguage: true,
    });
    expect(fake.turns[0]?.samples ?? 0).toBeGreaterThan(8000);
    expect(receivedBytes).toBe(
      CUES.clinician.length + 1600 + CUES.patient.length,
    );
  }, 15_000);

  /** An AI stream that has reached its first tone; `transfer` as the IVR sets it. */
  async function openAiStream(transfer: boolean) {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/media`, {
      headers: {
        'x-twilio-signature': twilioSignature(TOKEN, 'ws://gateway.test/media'),
      },
    });
    await once(ws, 'open');
    const marks: string[] = [];
    let waiter: (() => void) | undefined;
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as { mark?: { name: string } };
      if (m.mark !== undefined) {
        marks.push(m.mark.name);
        waiter?.();
      }
    });
    ws.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZ1',
        start: {
          accountSid: ACCOUNT_SID,
          streamSid: 'MZ1',
          callSid: 'CA1',
          customParameters: {
            clinicianLanguageId: 'en-US',
            patientLanguageId: 'es-US',
            ...(transfer ? { transfer: '1' } : {}),
          },
        },
      }),
    );
    const untilMarks = async (count: number) => {
      while (marks.length < count) {
        await new Promise<void>((resolve) => (waiter = resolve));
      }
    };
    await untilMarks(1); // the first tone: the call is live
    const press = (digit: string) =>
      ws.send(
        JSON.stringify({ event: 'dtmf', streamSid: 'MZ1', dtmf: { digit } }),
      );
    return { ws, press, untilMarks };
  }

  it('### closes the AI stream so Twilio continues to a human', async () => {
    const { ws, press } = await openAiStream(true);
    const closed = once(ws, 'close');
    press('#');
    press('#');
    press('#');
    const [code] = (await closed) as [number];
    expect(code).toBe(1000);
  }, 10_000);

  it('ignores ### (one double beep) when the IVR did not allow a human', async () => {
    const { ws, press, untilMarks } = await openAiStream(false);
    try {
      press('#');
      press('#');
      press('#');
      await untilMarks(2); // the "not possible" beep, and the stream stays up
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  }, 10_000);

  it('a # among other keys does not switch', async () => {
    const { ws, press } = await openAiStream(true);
    try {
      for (const digit of ['#', '#', '5', '#']) {
        press(digit);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
    }
  }, 10_000);

  it('sends a bearer token when machine auth is configured', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ access_token: 'abc', expires_in: 3600 }),
    ) as unknown as typeof fetch;
    const authHeaders = createAuthHeaders(
      {
        mode: 'client-credentials',
        tokenUrl: 'https://auth.test/oauth2/token',
        clientId: 'id',
        clientSecret: 'secret',
        scope: 'fourpoints-realtime/telephony.session',
      },
      fetchImpl,
    );
    await fetchLanguages({ url: fake.url, authHeaders });
    await fetchLanguages({ url: fake.url, authHeaders });
    expect(fake.authorization.at(-1)).toBe('Bearer abc');
    // The FourPoints edge WAF rejects upgrades that carry no User-Agent.
    expect(fake.userAgent.at(-1)).toBe('fourpoints-telephony');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // token reused
  });
});

describe('recorded prompts (integration)', () => {
  // 0.4 s greeting and 0.2 s of hold music, as distinct byte values.
  const prompts = PromptLibrary.of([
    {
      id: 'ai-connected-es-us',
      text: 'You are connected to the es-US AI Interpreter.',
      mulaw: new Uint8Array(3200).fill(0x11),
    },
    {
      id: 'hold-music',
      text: 'Hold music',
      mulaw: new Uint8Array(1600).fill(0x22),
    },
  ]);
  let fake: FakeFourPoints;
  let gateway: TelephonyServer;

  async function start(sessionDelayMs: number) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fake = await startFakeFourPoints(sessionDelayMs);
    const config = baseConfig(fake.url);
    const target = {
      url: config.fourPointsUrl,
      authHeaders: createAuthHeaders(config.fourPointsAuth),
    };
    const registry = new LanguageRegistry({
      fetchLanguages: () => fetchLanguages(target),
      clinicianLanguageId: 'en-US',
      order: [],
      refreshMs: 60_000,
    });
    await registry.refresh();
    gateway = await createTelephonyServer({
      config,
      target,
      menu: () => registry.menu,
      prompts,
    });
  }

  afterEach(async () => {
    await gateway.close(0);
    await fake.close();
    vi.restoreAllMocks();
  });

  /** Opens a stream with the greeting and records what the gateway sends, in order. */
  async function call() {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/media`, {
      headers: {
        'x-twilio-signature': twilioSignature(TOKEN, 'ws://gateway.test/media'),
      },
    });
    await once(ws, 'open');
    const events: {
      event: string;
      byte?: number;
      bytes?: number;
      mark?: string;
    }[] = [];
    let waiter: (() => void) | undefined;
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as {
        event: string;
        media?: { payload: string };
        mark?: { name: string };
      };
      const payload =
        m.media === undefined
          ? undefined
          : Buffer.from(m.media.payload, 'base64');
      events.push({
        event: m.event,
        ...(payload === undefined
          ? {}
          : { byte: payload[0], bytes: payload.length }),
        ...(m.mark === undefined ? {} : { mark: m.mark.name }),
      });
      waiter?.();
    });
    const until = async (test: () => boolean) => {
      while (!test()) {
        await new Promise<void>((resolve) => (waiter = resolve));
      }
    };
    const echo = (name: string) =>
      ws.send(
        JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: { name } }),
      );
    ws.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZ1',
        start: {
          accountSid: ACCOUNT_SID,
          streamSid: 'MZ1',
          callSid: 'CA1',
          customParameters: {
            clinicianLanguageId: 'en-US',
            patientLanguageId: 'es-US',
            greeting: 'ai-connected-es-us',
          },
        },
      }),
    );
    return { ws, events, until, echo };
  }

  const bytesOf = (events: { byte?: number; bytes?: number }[], byte: number) =>
    events
      .filter((e) => e.byte === byte)
      .reduce((n, e) => n + (e.bytes ?? 0), 0);

  it('plays the greeting, then hold music until FourPoints is ready, then the first tone', async () => {
    await start(1_500);
    const { ws, events, until, echo } = await call();
    try {
      await until(() => events.some((e) => e.mark === 'greeting'));
      expect(bytesOf(events, 0x11)).toBe(3200); // the whole greeting, first
      echo('greeting');
      await until(() => events.some((e) => e.mark === 'm1'));
      const clear = events.findIndex((e) => e.event === 'clear');
      const greeting = events.findIndex((e) => e.mark === 'greeting');
      expect(clear).toBeGreaterThan(greeting);
      // Music between the greeting and the clear; the clinician tone after it.
      expect(bytesOf(events.slice(greeting, clear), 0x22)).toBeGreaterThan(0);
      expect(events.slice(clear).some((e) => e.byte === 0x22)).toBe(false);
      expect(events.slice(clear).reduce((n, e) => n + (e.bytes ?? 0), 0)).toBe(
        CUES.clinician.length,
      );
    } finally {
      ws.close();
    }
  }, 10_000);

  it('goes straight from the greeting to the first tone when FourPoints is already ready', async () => {
    await start(0);
    const { ws, events, until, echo } = await call();
    try {
      await until(() => events.some((e) => e.mark === 'greeting'));
      await new Promise((resolve) => setTimeout(resolve, 100)); // session opens meanwhile
      echo('greeting');
      await until(() => events.some((e) => e.mark === 'm1'));
      expect(events.some((e) => e.event === 'clear')).toBe(false);
      expect(bytesOf(events, 0x22)).toBe(0);
    } finally {
      ws.close();
    }
  }, 10_000);

  it('serves prompt files for <Play>, cacheable, and nothing else', async () => {
    await start(0);
    const base = `http://127.0.0.1:${gateway.port}`;
    const ok = await fetch(`${base}/prompts/hold-music.wav`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('audio/wav');
    expect(ok.headers.get('cache-control')).toContain('immutable');
    const wav = Buffer.from(await ok.arrayBuffer());
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.length).toBe(46 + 1600);
    expect((await fetch(`${base}/prompts/nope.wav`)).status).toBe(404);
    expect((await fetch(`${base}/prompts/../manifest.json`)).status).toBe(404);
  });
});

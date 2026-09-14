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
  turns: { speaker: string; sampleRateHz: number; samples: number }[];
  authorization: (string | undefined)[];
  close(): Promise<void>;
}

async function startFakeFourPoints(): Promise<FakeFourPoints> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const fake: FakeFourPoints = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    turns: [],
    authorization: [],
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
  wss.on('connection', (ws, req) => {
    fake.authorization.push(req.headers.authorization);
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
    });
    expect(fake.turns[0]?.samples ?? 0).toBeGreaterThan(8000);
    expect(receivedBytes).toBe(
      CUES.clinician.length + 1600 + CUES.patient.length,
    );
  }, 15_000);

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
    expect(fetchImpl).toHaveBeenCalledTimes(1); // token reused
  });
});

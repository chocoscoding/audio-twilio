import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  PROTOCOL_VERSION,
  decodeTtsAudioFrame,
  encodeAudioFrame,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@fourpoints/protocol';

import {
  nextLineFor,
  startStandIn,
  type DemoScript,
  type StandIn,
  type StandInEvent,
} from './stand-in.js';

const SCRIPT: DemoScript = {
  title: 'test',
  clinicianLanguageId: 'en-US',
  patientLanguageId: 'es-US',
  lines: [
    { id: 'a', speaker: 'clinician', says: 'Hello there', translation: 'Hola' },
    { id: 'b', speaker: 'patient', says: 'Me duele', translation: 'It hurts' },
    {
      id: 'c',
      speaker: 'clinician',
      says: 'Take 500 mg',
      translation: 'Tome 50 mg',
      gate: { status: 'FAIL', reasons: ['Dosage changed'] },
    },
    {
      id: 'd',
      speaker: 'clinician',
      says: 'Take 500 mg',
      translation: 'Tome 500 mg',
    },
  ],
};

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('nextLineFor', () => {
  it('finds the next line for a speaker, wrapping around', () => {
    expect(nextLineFor(SCRIPT.lines, 0, 'patient')).toBe(1);
    expect(nextLineFor(SCRIPT.lines, 2, 'patient')).toBe(1);
    expect(nextLineFor(SCRIPT.lines, 1, 'clinician')).toBe(2);
    expect(nextLineFor([], 0, 'clinician')).toBe(-1);
  });
});

describe('FourPoints stand-in', () => {
  let standIn: StandIn;
  let events: StandInEvent[];
  let ws: WebSocket;
  let messages: ServerMessage[];
  let speechSamples: number;

  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const count = (type: ServerMessage['type']) =>
    messages.filter((m) => m.type === type).length;

  /** Speak one turn of 100 ms and wait until FourPoints finishes it. */
  const speak = async (speaker: 'clinician' | 'patient') => {
    const finished = count('metrics.turn');
    send({
      type: 'turn.start',
      speaker,
      speechStartMs: Date.now(),
      audioFormat: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
    });
    for (let sequence = 0; sequence < 5; sequence++) {
      ws.send(
        encodeAudioFrame({
          sequence,
          captureTimestampMs: Date.now(),
          samples: new Int16Array(320),
        }),
      );
    }
    send({ type: 'turn.end', speechEndMs: Date.now() });
    await waitFor(() => count('metrics.turn') > finished);
  };

  beforeEach(async () => {
    events = [];
    messages = [];
    speechSamples = 0;
    standIn = await startStandIn({
      port: 0,
      host: '127.0.0.1',
      script: SCRIPT,
      speech: new Map([
        ['a', new Int16Array(3200)],
        ['d', new Int16Array(1600)],
      ]),
      onEvent: (event) => events.push(event),
    });
    ws = new WebSocket(`ws://127.0.0.1:${standIn.port}`);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodeTtsAudioFrame(new Uint8Array(data as Buffer));
        speechSamples += frame === null ? 0 : frame.payload.byteLength / 2;
        return;
      }
      const message = parseServerMessage(data.toString());
      if (message !== null) {
        messages.push(message);
      }
    });
    await once(ws, 'open');
    send({ type: 'session.start', protocolVersion: PROTOCOL_VERSION });
    await waitFor(() => count('languages.available') === 1);
  });

  afterEach(async () => {
    ws.close();
    await standIn.close();
  });

  it('publishes the same registry projection FourPoints would for the pair', () => {
    const available = messages.find((m) => m.type === 'languages.available');
    expect(available).toMatchObject({
      defaultClinicianLanguageId: 'en-US',
      defaultPatientLanguageId: 'es-US',
    });
    if (available?.type === 'languages.available') {
      expect(
        available.languages.map((l) => [l.languageId, l.capabilityTier]),
      ).toEqual([
        ['en-US', 'FULL_VOICE'],
        ['es-US', 'FULL_VOICE'],
      ]);
    }
  });

  it('refuses a language pair the script does not cover', async () => {
    send({
      type: 'conversation.start',
      clinicianLanguageId: 'en-US',
      patientLanguageId: 'fr-FR',
    });
    await waitFor(() => count('error') === 1);
    expect(messages.at(-1)).toMatchObject({
      category: 'INVALID_LANGUAGE_ROUTE',
    });
  });

  it('answers a turn with the scripted line, speech and measured audio stats', async () => {
    send({
      type: 'conversation.start',
      clinicianLanguageId: 'en-US',
      patientLanguageId: 'es-US',
    });
    await waitFor(() => count('conversation.languages') === 1);
    await speak('clinician');
    const types = messages.map((m) => m.type);
    expect(types.indexOf('transcript.final')).toBeLessThan(
      types.indexOf('translation.final'),
    );
    expect(messages.find((m) => m.type === 'translation.final')).toMatchObject({
      text: 'Hola',
    });
    expect(messages.find((m) => m.type === 'quality.result')).toMatchObject({
      result: { status: 'PASS' },
    });
    expect(speechSamples).toBe(3200);
    expect(messages.find((m) => m.type === 'metrics.turn')).toMatchObject({
      metrics: {
        latencies: {},
        audio: { framesReceived: 5, audioDurationMs: 100 },
      },
    });
  });

  it('blocks a failed line without speech, then speaks the repeat', async () => {
    send({
      type: 'conversation.start',
      clinicianLanguageId: 'en-US',
      patientLanguageId: 'es-US',
    });
    await waitFor(() => count('conversation.languages') === 1);
    await speak('clinician'); // a
    const spokenBefore = count('tts.started');
    await speak('clinician'); // skips patient line b → c (blocked)
    expect(count('tts.started')).toBe(spokenBefore);
    expect(messages.filter((m) => m.type === 'warning').at(-1)).toMatchObject({
      category: 'QUALITY_VALIDATION_FAILED',
    });
    await speak('clinician'); // d
    expect(count('tts.started')).toBe(spokenBefore + 1);
    expect(events.filter((e) => e.kind === 'blocked')).toHaveLength(1);
  });
});

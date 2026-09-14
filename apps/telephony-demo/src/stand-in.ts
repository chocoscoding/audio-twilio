/**
 * FourPoints stand-in for demos: a WebSocket server that speaks realtime
 * protocol v1 like apps/realtime, but answers each turn from a fixed script
 * instead of Transcribe → Translate → quality gate → Polly.
 *
 * Nothing is recognised: whoever speaks gets the next scripted line for
 * their role. Everything the gateway sees — message order, binary frame
 * layout, quality verdicts, speech format — is the real contract, so the
 * gateway runs unchanged against it.
 */

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

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

export type Speaker = 'clinician' | 'patient';

export interface ScriptLine {
  id: string;
  speaker: Speaker;
  /** What the speaker is scripted to say, in their own language. */
  says: string;
  /** What the listener hears, in the other language. */
  translation: string;
  /** Scripted quality verdict; FAIL means the line is never spoken. */
  gate?: { status: 'WARN' | 'FAIL'; reasons: string[] };
}

export interface DemoScript {
  title: string;
  clinicianLanguageId: string;
  patientLanguageId: string;
  lines: ScriptLine[];
}

export type StandInEvent =
  | { kind: 'conversation'; state: 'opened' | 'closed' }
  | { kind: 'listening'; speaker: Speaker }
  | { kind: 'heard'; speaker: Speaker; audioMs: number }
  | {
      kind: 'translated';
      index: number;
      line: ScriptLine;
      status: 'PASS' | 'WARN' | 'FAIL';
    }
  | { kind: 'spoken'; index: number; audioMs: number }
  | { kind: 'blocked'; index: number };

export interface StandInOptions {
  port: number;
  host: string;
  script: DemoScript;
  /** 16 kHz mono PCM for each spoken line, keyed by line id. */
  speech: ReadonlyMap<string, Int16Array>;
  onEvent: (event: StandInEvent) => void;
}

export interface StandIn {
  port: number;
  close(): Promise<void>;
}

const SPEECH_RATE_HZ = 16000;
/** 100 ms per frame, sent faster than real time, as Polly streams. */
const SPEECH_CHUNK_SAMPLES = 1600;
/** Pacing so the demo feels like a live pipeline. Not FourPoints measurements. */
const RECOGNITION_PAUSE_MS = 350;
const TRANSLATION_PAUSE_MS = 150;

/** Same display names as apps/realtime/src/languages.ts. */
const DISPLAY_NAMES: Record<string, string> = {
  'en-US': 'English (US)',
  'es-US': 'Spanish (US)',
};

function capability(languageId: string): WireLanguageCapability {
  return {
    languageId,
    displayName: DISPLAY_NAMES[languageId] ?? languageId,
    input: { speech: true, text: true },
    output: { speech: true, text: true },
    capabilityTier: 'FULL_VOICE',
    validationStatus: 'DEMO_VALIDATED',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Index of the next line for `speaker`, searching forward from `cursor` and wrapping. */
export function nextLineFor(
  lines: readonly ScriptLine[],
  cursor: number,
  speaker: Speaker,
): number {
  for (let step = 0; step < lines.length; step++) {
    const index = (cursor + step) % lines.length;
    if (lines[index]?.speaker === speaker) {
      return index;
    }
  }
  return -1;
}

interface OpenTurn {
  id: string;
  speaker: Speaker;
  rateHz: number;
  speechStartMs: number;
  frames: number;
  bytes: number;
  samples: number;
  gaps: number;
  nextSequence: number;
}

function serve(
  ws: WebSocket,
  { script, speech, onEvent }: StandInOptions,
): void {
  const send = (message: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };
  let conversation = false;
  let cursor = 0;
  let turnCount = 0;
  let turn: OpenTurn | undefined;

  const answer = async (t: OpenTurn, speechEndMs: number) => {
    const audioMs = Math.round((t.samples / t.rateHz) * 1000);
    onEvent({ kind: 'heard', speaker: t.speaker, audioMs });
    // Only values this process actually measured; no provider latencies exist here.
    const metrics: TurnMetrics = {
      timestamps: { speechStart: t.speechStartMs, speechEnd: speechEndMs },
      latencies: {},
      audio: {
        framesReceived: t.frames,
        bytesReceived: t.bytes,
        sequenceGaps: t.gaps,
        audioDurationMs: audioMs,
      },
    };
    const index = nextLineFor(script.lines, cursor, t.speaker);
    const line = script.lines[index];
    if (line === undefined) {
      send({ type: 'metrics.turn', turnId: t.id, metrics });
      return;
    }
    cursor = index + 1;

    const words = line.says.split(' ');
    await sleep(RECOGNITION_PAUSE_MS / 2);
    send({
      type: 'transcript.partial',
      turnId: t.id,
      text: words.slice(0, Math.ceil(words.length / 2)).join(' '),
    });
    await sleep(RECOGNITION_PAUSE_MS / 2);
    send({ type: 'transcript.final', turnId: t.id, text: line.says });
    send({ type: 'translation.started', turnId: t.id });
    await sleep(TRANSLATION_PAUSE_MS);
    send({ type: 'translation.final', turnId: t.id, text: line.translation });
    const status = line.gate?.status ?? 'PASS';
    send({
      type: 'quality.result',
      turnId: t.id,
      result: { status, reasons: line.gate?.reasons ?? [] },
    });
    onEvent({ kind: 'translated', index, line, status });

    if (status === 'FAIL') {
      // FourPoints' turn-level gate (SLICE5-006): nothing of the turn is spoken.
      send({
        type: 'warning',
        category: 'QUALITY_VALIDATION_FAILED',
        message:
          'The translation could not be verified and was not spoken. Please repeat the phrase.',
      });
      send({ type: 'metrics.turn', turnId: t.id, metrics });
      onEvent({ kind: 'blocked', index });
      return;
    }

    const pcm = speech.get(line.id) ?? new Int16Array(SPEECH_RATE_HZ / 4);
    send({
      type: 'tts.started',
      turnId: t.id,
      audioFormat: {
        encoding: 'pcm_s16le',
        sampleRateHz: SPEECH_RATE_HZ,
        channels: 1,
      },
    });
    for (
      let at = 0, sequence = 0;
      at < pcm.length;
      at += SPEECH_CHUNK_SAMPLES, sequence++
    ) {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const chunk = pcm.subarray(at, at + SPEECH_CHUNK_SAMPLES);
      ws.send(
        encodeTtsAudioFrame({
          sequence,
          timestampMs: Date.now(),
          payload: new Uint8Array(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
          ),
        }),
      );
      await sleep(20);
    }
    send({ type: 'tts.ended', turnId: t.id });
    send({ type: 'metrics.turn', turnId: t.id, metrics });
    onEvent({
      kind: 'spoken',
      index,
      audioMs: Math.round((pcm.length / SPEECH_RATE_HZ) * 1000),
    });
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data;
      const frame = decodeAudioFrame(bytes);
      if (turn !== undefined && frame !== null) {
        if (frame.sequence !== turn.nextSequence) {
          turn.gaps += 1;
        }
        turn.nextSequence = frame.sequence + 1;
        turn.frames += 1;
        turn.bytes += bytes.byteLength;
        turn.samples += frame.samples.length;
      }
      return;
    }
    const message = parseClientMessage(data.toString());
    switch (message?.type) {
      case 'session.start':
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          send({
            type: 'error',
            category: 'PROTOCOL_VERSION_UNSUPPORTED',
            message: 'Unsupported protocol version.',
          });
          ws.close(1002);
          return;
        }
        send({
          type: 'session.ready',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: `demo-${Date.now()}`,
        });
        send({
          type: 'languages.available',
          languages: [
            capability(script.clinicianLanguageId),
            capability(script.patientLanguageId),
          ],
          defaultClinicianLanguageId: script.clinicianLanguageId,
          defaultPatientLanguageId: script.patientLanguageId,
        });
        break;
      case 'conversation.start':
        if (
          message.clinicianLanguageId !== script.clinicianLanguageId ||
          message.patientLanguageId !== script.patientLanguageId
        ) {
          send({
            type: 'error',
            category: 'INVALID_LANGUAGE_ROUTE',
            message: 'The demo script covers only its own language pair.',
          });
          return;
        }
        conversation = true;
        cursor = 0;
        send({
          type: 'conversation.ready',
          conversationId: 'demo-conversation',
        });
        send({
          type: 'conversation.languages',
          conversationId: 'demo-conversation',
          clinicianLanguageId: script.clinicianLanguageId,
          patientLanguageId: script.patientLanguageId,
        });
        onEvent({ kind: 'conversation', state: 'opened' });
        break;
      case 'turn.start':
        if (!conversation) {
          send({
            type: 'error',
            category: 'PROTOCOL_ERROR',
            message: 'Start a conversation before speaking.',
          });
          return;
        }
        turnCount += 1;
        turn = {
          id: `turn-${turnCount}`,
          speaker: message.speaker,
          rateHz: message.audioFormat.sampleRateHz,
          speechStartMs: message.speechStartMs,
          frames: 0,
          bytes: 0,
          samples: 0,
          gaps: 0,
          nextSequence: 0,
        };
        send({ type: 'listening', turnId: turn.id });
        onEvent({ kind: 'listening', speaker: message.speaker });
        break;
      case 'turn.end':
        if (turn !== undefined) {
          const finished = turn;
          turn = undefined;
          void answer(finished, message.speechEndMs);
        }
        break;
      case 'conversation.end':
        conversation = false;
        turn = undefined;
        break;
      case 'session.end':
        ws.close(1000);
        break;
      default:
        break;
    }
  });
  ws.on('error', () => undefined);
  ws.on('close', () => {
    if (conversation) {
      onEvent({ kind: 'conversation', state: 'closed' });
    }
  });
}

export async function startStandIn(options: StandInOptions): Promise<StandIn> {
  const wss = new WebSocketServer({
    port: options.port,
    host: options.host,
    maxPayload: 1024 * 1024,
  });
  await once(wss, 'listening');
  wss.on('connection', (ws) => serve(ws, options));
  return {
    port: (wss.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}

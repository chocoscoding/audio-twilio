/**
 * Client for the FourPoints realtime WebSocket protocol, version 1 — the
 * same contract the browser speaks (@fourpoints/protocol). Nothing here
 * needs a FourPoints change: it is one more client.
 */

import WebSocket from 'ws';

import {
  PROTOCOL_VERSION,
  decodeTtsAudioFrame,
  encodeAudioFrame,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type WireLanguageCapability,
} from '@fourpoints/protocol';

import type { AuthHeaders } from './auth.js';
import type { Speaker } from './floor.js';

const SETUP_TIMEOUT_MS = 8_000;
const PING_INTERVAL_MS = 20_000;
/** Matches the FourPoints transport cap. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Drop the session rather than queue audio without bound on a stalled link. */
const MAX_BUFFERED_BYTES = 256 * 1024;

export interface FourPointsTarget {
  url: string;
  authHeaders: AuthHeaders;
}

export interface LanguagePair {
  clinicianLanguageId: string;
  patientLanguageId: string;
}

export interface SessionHandlers {
  onMessage(message: ServerMessage): void;
  /** Synthesized speech bytes (pcm_s16le at the rate in `tts.started`). */
  onSpeechAudio(pcm: Uint8Array): void;
  onClosed(): void;
}

function bytesOf(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

function send(ws: WebSocket, message: ClientMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

async function connect(target: FourPointsTarget): Promise<WebSocket> {
  const headers = await target.authHeaders();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.url, {
      headers,
      maxPayload: MAX_PAYLOAD_BYTES,
      handshakeTimeout: SETUP_TIMEOUT_MS,
    });
    ws.once('error', reject);
    ws.once('open', () => {
      ws.off('error', reject);
      ws.on('error', () => undefined); // a 'close' event always follows
      resolve(ws);
    });
  });
}

/**
 * Run the opening handshake: `session.start`, then hand each control message
 * to `step` until it returns a result. Rejects on timeout, early close or a
 * FourPoints `error`.
 */
function handshake<T>(
  ws: WebSocket,
  step: (message: ServerMessage) => T | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (error: Error | null, value?: T) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      if (error !== null) {
        ws.terminate();
        reject(error);
      } else {
        resolve(value as T);
      }
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        return;
      }
      const message = parseServerMessage(data.toString());
      if (message?.type === 'error') {
        finish(new Error(`FourPoints refused: ${message.category}`));
        return;
      }
      const result = message === null ? undefined : step(message);
      if (result !== undefined) {
        finish(null, result);
      }
    };
    const onClose = () => finish(new Error('FourPoints closed during setup'));
    const timer = setTimeout(
      () => finish(new Error('FourPoints setup timed out')),
      SETUP_TIMEOUT_MS,
    );
    ws.on('message', onMessage);
    ws.on('close', onClose);
    send(ws, { type: 'session.start', protocolVersion: PROTOCOL_VERSION });
  });
}

/** Read the registry projection, then end the session. */
export async function fetchLanguages(
  target: FourPointsTarget,
): Promise<WireLanguageCapability[]> {
  const ws = await connect(target);
  const languages = await handshake(ws, (message) =>
    message.type === 'languages.available' ? message.languages : undefined,
  );
  send(ws, { type: 'session.end' });
  ws.close(1000);
  return languages;
}

/** One FourPoints session carrying one call's conversation. */
export class FourPointsSession {
  readonly openedAt = Date.now();
  private turns = 0;
  private sequence = 0;

  private constructor(
    private readonly ws: WebSocket,
    private readonly sampleRateHz: number,
    handlers: SessionHandlers,
  ) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodeTtsAudioFrame(bytesOf(data));
        if (frame !== null) {
          handlers.onSpeechAudio(frame.payload);
        }
        return;
      }
      const message = parseServerMessage(data.toString());
      if (message !== null) {
        handlers.onMessage(message);
      }
    });
    const ping = setInterval(() => ws.ping(), PING_INTERVAL_MS);
    ws.on('close', () => {
      clearInterval(ping);
      handlers.onClosed();
    });
  }

  static async open(
    target: FourPointsTarget,
    pair: LanguagePair,
    sampleRateHz: number,
    handlers: SessionHandlers,
  ): Promise<FourPointsSession> {
    const ws = await connect(target);
    await handshake(ws, (message) => {
      if (message.type === 'languages.available') {
        send(ws, { type: 'conversation.start', ...pair });
      }
      return message.type === 'conversation.languages' ? true : undefined;
    });
    return new FourPointsSession(ws, sampleRateHz, handlers);
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  get ageMs(): number {
    return Date.now() - this.openedAt;
  }

  get turnCount(): number {
    return this.turns;
  }

  startTurn(speaker: Speaker): void {
    this.turns += 1;
    this.sequence = 0;
    send(this.ws, {
      type: 'turn.start',
      speaker,
      speechStartMs: Date.now(),
      audioFormat: {
        encoding: 'pcm_s16le',
        sampleRateHz: this.sampleRateHz,
        channels: 1,
      },
    });
  }

  sendAudio(samples: Int16Array): void {
    if (!this.isOpen) {
      return;
    }
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.ws.terminate(); // stalled link: fail fast, the call recovers
      return;
    }
    this.ws.send(
      encodeAudioFrame({
        sequence: this.sequence++,
        captureTimestampMs: Date.now(),
        samples,
      }),
    );
  }

  endTurn(): void {
    send(this.ws, { type: 'turn.end', speechEndMs: Date.now() });
  }

  close(): void {
    send(this.ws, { type: 'session.end' });
    this.ws.close(1000);
  }
}

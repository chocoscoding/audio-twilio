import type {
  ClientMessage,
  ServerMessage,
  WireAudioFormat,
} from './messages.js';

const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'session.start',
  'conversation.start',
  'turn.start',
  'turn.end',
  'language.change',
  'conversation.end',
  'session.end',
] satisfies ClientMessage['type'][]);

const SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'session.ready',
  'languages.available',
  'conversation.ready',
  'conversation.languages',
  'listening',
  'turn.speaker',
  'transcript.partial',
  'transcript.final',
  'translation.started',
  'translation.final',
  'quality.result',
  'tts.started',
  'tts.ended',
  'metrics.turn',
  'warning',
  'error',
  'reconnecting',
] satisfies ServerMessage['type'][]);

function hasKnownType(
  value: unknown,
  knownTypes: ReadonlySet<string>,
): value is { type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    knownTypes.has((value as { type: string }).type)
  );
}

export function isClientMessage(value: unknown): value is ClientMessage {
  return hasKnownType(value, CLIENT_MESSAGE_TYPES);
}

export function isServerMessage(value: unknown): value is ServerMessage {
  return hasKnownType(value, SERVER_MESSAGE_TYPES);
}

/**
 * Parse a JSON text frame into a client message, or null when the frame is
 * not valid JSON or not a known client message type. Unknown frames must be
 * rejected explicitly, never dispatched on an untyped event name (spec §21).
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  return parseMessage(raw, isClientMessage);
}

/** Parse a JSON text frame into a server message, or null when invalid. */
export function parseServerMessage(raw: string): ServerMessage | null {
  return parseMessage(raw, isServerMessage);
}

function parseMessage<T>(
  raw: string,
  guard: (value: unknown) => value is T,
): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return guard(parsed) ? parsed : null;
}

/**
 * Audio sample rates the realtime wire contract accepts.
 *
 * The FourPoints contract is PCM16 at 16 kHz. A future telephony channel
 * carries 8 kHz mulaw, but that is converted to this contract at the
 * `AudioSource` boundary, so the WIRE set does not widen for it.
 */
export const SUPPORTED_SAMPLE_RATES_HZ: readonly number[] = [16_000];

/**
 * Structural validation of a client-declared audio format.
 *
 * `parseClientMessage` validates only the message TYPE, so every other field
 * of a control message is attacker-controlled until something checks it.
 * `turn.start.audioFormat` is not inert data: its `sampleRateHz` sizes the
 * audio chunk buffer and drives turn duration arithmetic.
 *
 * A declared rate of 0 makes the chunk size 0, and a zero-length chunk
 * buffer never advances the aggregator's read offset — the push loop spins
 * forever, emitting an empty chunk per iteration into a growing array. One
 * control message plus one audio frame is therefore enough to pin an ECS
 * task's event loop and exhaust its heap, taking down every session that
 * task is serving, not merely the sender's. That is why this is an
 * allowlist of exact supported values rather than a range check or a
 * non-zero check.
 */
export function isWireAudioFormat(value: unknown): value is WireAudioFormat {
  if (typeof value !== 'object' || value === null) return false;
  const format = value as Record<string, unknown>;
  return (
    format.encoding === 'pcm_s16le' &&
    format.channels === 1 &&
    typeof format.sampleRateHz === 'number' &&
    // Subsumed by the allowlist TODAY — `[16_000].includes(16_000.5)` and
    // `.includes(NaN)` are both false — and kept deliberately. It is the
    // check that still holds if the allowlist is ever widened to a range,
    // which is the edit most likely to reintroduce a fractional or NaN rate.
    // `allowlistShape` below pins the assumption that makes it redundant, so
    // the redundancy cannot become the only thing standing.
    Number.isInteger(format.sampleRateHz) &&
    SUPPORTED_SAMPLE_RATES_HZ.includes(format.sampleRateHz)
  );
}

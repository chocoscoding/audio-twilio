import type { ClientMessage, ServerMessage } from './messages.js';

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

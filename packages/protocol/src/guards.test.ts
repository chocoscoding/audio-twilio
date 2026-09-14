import { describe, expect, it } from 'vitest';

import { parseClientMessage, parseServerMessage } from './guards.js';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from './messages.js';

describe('protocol message parsing', () => {
  it('parses a valid client control message', () => {
    const message: ClientMessage = {
      type: 'conversation.start',
      clinicianLanguageId: 'en-US',
      patientLanguageId: 'es-US',
    };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it('parses a valid server message', () => {
    const message: ServerMessage = {
      type: 'session.ready',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'session-1',
    };
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it('rejects invalid JSON', () => {
    expect(parseClientMessage('not json{')).toBeNull();
  });

  it('rejects unknown message types', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'unknown.event' })),
    ).toBeNull();
  });

  it('rejects messages without a type discriminant', () => {
    expect(parseClientMessage(JSON.stringify({ text: 'hello' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify(null))).toBeNull();
    expect(parseClientMessage(JSON.stringify(42))).toBeNull();
  });

  it('does not accept server message types as client messages', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'transcript.partial' })),
    ).toBeNull();
  });
});

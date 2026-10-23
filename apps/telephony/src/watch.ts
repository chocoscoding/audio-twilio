/**
 * The watch stream: during a human call, a one-way copy of the caller's
 * audio (`<Start><Stream track="inbound_track">`) on which the gateway
 * listens for `###`, the key sequence that moves the caller to the AI.
 *
 * In a human call Twilio `<Dial>` connects the caller and the interpreter
 * directly and reports no keypresses, so the keypad tones are found in the
 * audio itself (dtmf-tone.ts). On `###` the interpreter's leg is released
 * (twilio-rest.ts) and the caller's call continues at `<Dial action>`.
 *
 * Audio is decoded, examined in memory and dropped: it is never stored,
 * logged or sent anywhere. One closure per stream; nothing is shared.
 */

import type WebSocket from 'ws';

import { decodeMulaw } from './audio.js';
import { DtmfToneDetector } from './dtmf-tone.js';
import { KeySequence } from './key-sequence.js';
import { log, redactId } from './log.js';
import { isCallSid, type TwilioRest } from './twilio-rest.js';

/** Twilio must send `start` promptly after connecting. */
const START_TIMEOUT_MS = 5_000;
/** Larger text messages are not Twilio's and are not parsed. */
const MAX_MESSAGE_BYTES = 16 * 1024;
/** A media payload is 20 ms (≈ 216 base64 chars); this bounds decoding work. */
const MAX_PAYLOAD_CHARS = 8 * 1024;

export interface WatchOptions {
  accountSid: string;
  rest: TwilioRest;
  /** TwiML given to the interpreter's leg on `###`. */
  releaseTwiml: string;
  onEnd: () => void;
}

type Json = Record<string, unknown>;

/** A frame above about -40 dBFS RMS: someone or something is making sound. */
const isLoud = (samples: Int16Array): boolean => {
  let sum = 0;
  for (const s of samples) {
    sum += s * s;
  }
  return samples.length > 0 && Math.sqrt(sum / samples.length) > 328;
};

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null;

const byteLength = (data: WebSocket.RawData): number =>
  Array.isArray(data)
    ? data.reduce((sum, part) => sum + part.length, 0)
    : data instanceof ArrayBuffer
      ? data.byteLength
      : data.length;

export function runWatch(twilio: WebSocket, options: WatchOptions): void {
  let callSid = '';
  let callId = 'unknown';
  let ended = false;
  let switchRequested = false;
  // Once Twilio reports keys itself, trust only its events: the same press
  // would otherwise be counted twice (tone and event).
  let dtmfEvents = false;
  const detector = new DtmfToneDetector();
  const sequence = new KeySequence();
  // Content-free counts, logged when the stream ends, so a missed ### can be
  // told apart: no audio, audio without key tones, or tones not recognised.
  // Never the digits themselves (they may be an interpreter line's PIN).
  const seen = {
    frames: 0,
    otherTrack: 0,
    loud: 0,
    keys: 0,
    pounds: 0,
    events: 0,
  };
  const tracks = new Set<string>();

  const endWatch = (reason: string) => {
    if (ended) {
      return;
    }
    ended = true;
    clearTimeout(startTimer);
    log('watch.ended', {
      call: callId,
      reason,
      ...seen,
      tracks: [...tracks].join(',') || 'none',
    });
    options.onEnd();
  };

  /** Close the stream; the call itself goes on unaffected. */
  const closeStream = (reason: string) => {
    log('watch.closed_by_gateway', { call: callId, reason });
    twilio.close(1000);
    endWatch(reason);
  };

  const onKey = (digit: string) => {
    seen.keys += 1;
    if (digit === '#') {
      seen.pounds += 1;
    }
    if (switchRequested || !sequence.press(digit)) {
      return;
    }
    switchRequested = true;
    log('watch.switch_requested', { call: callId });
    void options.rest
      .releaseHumanLeg(callSid, options.releaseTwiml)
      .then((result) => {
        log('watch.switch_result', { call: callId, result });
        // The caller is leaving the human call; this copy of the audio is no
        // longer needed (the AI leg brings its own stream).
        if (result === 'released' && !ended) {
          closeStream('switched');
        }
      });
  };

  const onStart = (start: Json) => {
    const sid = start['callSid'];
    callId = typeof sid === 'string' ? redactId(sid) : 'unknown';
    if (start['accountSid'] !== options.accountSid) {
      closeStream('wrong_account');
      return;
    }
    if (!isCallSid(sid)) {
      closeStream('invalid_parameters');
      return;
    }
    callSid = sid;
    log('watch.started', { call: callId });
  };

  const startTimer = setTimeout(
    () => closeStream('no_start'),
    START_TIMEOUT_MS,
  );

  twilio.on('message', (data, isBinary) => {
    if (isBinary || ended || byteLength(data) > MAX_MESSAGE_BYTES) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!isJson(message)) {
      return;
    }
    switch (message['event']) {
      case 'start':
        if (callSid === '' && isJson(message['start'])) {
          clearTimeout(startTimer);
          onStart(message['start']);
        }
        break;
      case 'media': {
        const media = message['media'];
        if (isJson(media)) {
          seen.frames += 1;
          const track = media['track'];
          if (typeof track === 'string' && tracks.size < 4) {
            tracks.add(track.slice(0, 32));
          }
          if (track !== undefined && track !== 'inbound') {
            seen.otherTrack += 1;
          }
        }
        if (
          callSid !== '' &&
          !dtmfEvents &&
          isJson(media) &&
          typeof media['payload'] === 'string' &&
          media['payload'].length <= MAX_PAYLOAD_CHARS &&
          (media['track'] === undefined || media['track'] === 'inbound')
        ) {
          const samples = decodeMulaw(Buffer.from(media['payload'], 'base64'));
          if (isLoud(samples)) {
            seen.loud += 1;
          }
          for (const digit of detector.push(samples)) {
            onKey(digit);
          }
        }
        break;
      }
      case 'dtmf': {
        const dtmf = message['dtmf'];
        if (
          callSid !== '' &&
          isJson(dtmf) &&
          typeof dtmf['digit'] === 'string' &&
          dtmf['digit'].length === 1
        ) {
          seen.events += 1;
          if (!dtmfEvents) {
            dtmfEvents = true;
            sequence.reset(); // drop any tone-detected press of this key
          }
          onKey(dtmf['digit']);
        }
        break;
      }
      case 'stop':
        endWatch('twilio_stop');
        break;
      default:
        break;
    }
  });
  twilio.on('close', () => endWatch('twilio_closed'));
  twilio.on('error', () => undefined); // 'close' follows
}

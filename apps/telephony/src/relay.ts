/**
 * The human-call relay: the gateway sits between the caller and a human
 * interpreter line, so it sees the caller's keypresses (### to the AI).
 *
 *   caller ── <Connect><Stream> /relay ──▶ gateway ◀── /relay-leg <Connect><Stream> ── interpreter
 *
 * With Twilio <Dial>, the two are joined inside Twilio and a keypress never
 * reaches the gateway: Twilio sends no key events on a one-way stream, and
 * phones usually send keys outside the audio. So for a human call the IVR
 * opens a two-way stream instead (/relay). The gateway rings the interpreter
 * line through the Twilio REST API with TwiML that opens a second two-way
 * stream (/relay-leg), and passes the 8 kHz μ-law frames between the two
 * unchanged. The caller's other keys are played to the interpreter line as
 * tones, so its menus still work.
 *
 * When the relay ends, the gateway closes the caller's stream and Twilio
 * continues at <Connect action> (/voice/relay-ended). That webhook cannot
 * see why the stream ended, so the reason is kept here for a few minutes
 * (RelayHub.take). It is per instance: Helicarrier runs one. On another
 * instance the webhook finds no reason and treats the call as unanswered.
 *
 * Audio is passed through in memory: never stored, logged or sent to
 * FourPoints. Logs carry a redacted call id and timings only.
 */

import type WebSocket from 'ws';

import { dtmfTone } from './audio.js';
import type { CompanySource } from './companies.js';
import type { TelephonyConfig } from './config.js';
import { KeySequence } from './key-sequence.js';
import { log, redactId } from './log.js';
import type { PromptLibrary } from './prompts.js';
import { isCallSid, type TwilioRest } from './twilio-rest.js';
import { element, response } from './twiml.js';

/** Why a relay ended; read once by /voice/relay-ended. */
export type RelayOutcome =
  'switch_to_ai' | 'interpreter_ended' | 'no_answer' | 'time_limit';

/** Twilio must send `start` promptly after connecting. */
const START_TIMEOUT_MS = 5_000;
/** How long the interpreter line rings before the caller is told no one answered. */
const RING_TIMEOUT_MS = 35_000;
/** How often a ringing interpreter leg is checked (busy, failed, no answer). */
const POLL_MS = 3_000;
/** A reason waits this long for /voice/relay-ended. */
const OUTCOME_TTL_MS = 5 * 60_000;
/** A media payload is 20 ms (≈ 216 base64 chars); larger is not Twilio's. */
const MAX_PAYLOAD_CHARS = 8 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
/** Hold music goes out 200 ms at a time, a second ahead of playback. */
const MUSIC_CHUNK_BYTES = 1600;
const MUSIC_LEAD_MS = 1_000;
/** Ringing call states that mean nobody will answer. */
const NOT_ANSWERED = new Set([
  'busy',
  'failed',
  'no-answer',
  'canceled',
  'completed',
]);

export interface RelayTiming {
  startTimeoutMs: number;
  ringTimeoutMs: number;
  pollMs: number;
}

const DEFAULT_TIMING: RelayTiming = {
  startTimeoutMs: START_TIMEOUT_MS,
  ringTimeoutMs: RING_TIMEOUT_MS,
  pollMs: POLL_MS,
};

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null;

/** Parse a Twilio text frame; undefined for anything else. */
function parse(data: WebSocket.RawData, isBinary: boolean): Json | undefined {
  if (isBinary) {
    return undefined;
  }
  const text = data.toString();
  if (text.length > MAX_MESSAGE_BYTES) {
    return undefined;
  }
  try {
    const message: unknown = JSON.parse(text);
    return isJson(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

/** The base64 μ-law payload of a media frame, if it is one. */
function mediaPayload(message: Json): string | undefined {
  const media = message['media'];
  return isJson(media) &&
    typeof media['payload'] === 'string' &&
    media['payload'].length <= MAX_PAYLOAD_CHARS &&
    (media['track'] === undefined || media['track'] === 'inbound')
    ? media['payload']
    : undefined;
}

interface LegAttach {
  (leg: WebSocket, legStreamSid: string): boolean;
}

/** Live relays and their reasons for ending, on this instance. */
export class RelayHub {
  private readonly waiting = new Map<string, LegAttach>();
  private readonly outcomes = new Map<
    string,
    { outcome: RelayOutcome; at: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** A caller waiting for its interpreter leg to connect. */
  wait(callSid: string, attach: LegAttach): void {
    this.waiting.set(callSid, attach);
  }

  stopWaiting(callSid: string): void {
    this.waiting.delete(callSid);
  }

  /** The interpreter leg's stream arrived; false if no caller waits for it. */
  attach(parentCallSid: string, leg: WebSocket, legStreamSid: string): boolean {
    const attach = this.waiting.get(parentCallSid);
    return attach !== undefined && attach(leg, legStreamSid);
  }

  record(callSid: string, outcome: RelayOutcome): void {
    const now = this.now();
    for (const [sid, entry] of this.outcomes) {
      if (now - entry.at > OUTCOME_TTL_MS) {
        this.outcomes.delete(sid);
      }
    }
    this.outcomes.set(callSid, { outcome, at: now });
  }

  /** Why the relay for this call ended, once; undefined if unknown. */
  take(callSid: string): RelayOutcome | undefined {
    const entry = this.outcomes.get(callSid);
    this.outcomes.delete(callSid);
    return entry !== undefined && this.now() - entry.at <= OUTCOME_TTL_MS
      ? entry.outcome
      : undefined;
  }
}

export interface RelayOptions {
  config: TelephonyConfig;
  rest: TwilioRest;
  hub: RelayHub;
  companies?: CompanySource;
  prompts?: PromptLibrary;
  /** TwiML the interpreter's leg gets when the caller switches to the AI. */
  releaseTwiml: string;
  onEnd: () => void;
  timing?: Partial<RelayTiming>;
}

/**
 * The caller's side of a relay (/relay). Customer parameters from the IVR:
 * `lang` (language chosen, optional), `limit` (seconds, the minutes left),
 * `switch` ("1" when ### may move the caller to the AI). Nothing that names
 * the organization.
 */
export function runRelayCaller(caller: WebSocket, options: RelayOptions): void {
  const { config, rest, hub } = options;
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  let callSid = '';
  let callId = 'unknown';
  let streamSid = '';
  let phase: 'starting' | 'ringing' | 'connected' | 'done' = 'starting';
  let legSid: string | undefined;
  let leg: WebSocket | undefined;
  let legStreamSid = '';
  let switchAllowed = false;
  let limitMs = 0;
  let ringStartedAt = 0;
  let connectedAt = 0;
  const timers: NodeJS.Timeout[] = [];
  const keys = new KeySequence();
  let stopMusic: (() => void) | undefined;

  const send = (socket: WebSocket | undefined, message: Json) => {
    if (socket !== undefined && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };
  const later = (ms: number, work: () => void) => {
    timers.push(setTimeout(work, ms));
  };

  /** End the relay; the caller's call continues at <Connect action>. */
  const finish = (reason: string, outcome?: RelayOutcome) => {
    if (phase === 'done') {
      return;
    }
    const wasConnected = phase === 'connected';
    phase = 'done';
    for (const timer of timers) {
      clearTimeout(timer);
    }
    stopMusic?.();
    hub.stopWaiting(callSid);
    if (outcome !== undefined && callSid !== '') {
      hub.record(callSid, outcome);
    }
    log('relay.ended', {
      call: callId,
      reason,
      ...(wasConnected
        ? { connectedSeconds: Math.round((Date.now() - connectedAt) / 1000) }
        : {}),
    });
    if (caller.readyState === caller.OPEN) {
      caller.close(1000);
    }
    options.onEnd();
  };

  /** Ring tone stand-in: hold music, a second ahead, cut with `clear`. */
  const startMusic = () => {
    const music = options.prompts?.clip('hold-music');
    if (music === undefined || music.mulaw.length === 0) {
      return;
    }
    const started = Date.now();
    let sentMs = 0;
    let offset = 0;
    let timer: NodeJS.Timeout | undefined;
    const pump = () => {
      while (sentMs < Date.now() - started + MUSIC_LEAD_MS) {
        const chunk = music.mulaw.subarray(offset, offset + MUSIC_CHUNK_BYTES);
        send(caller, {
          event: 'media',
          streamSid,
          media: { payload: Buffer.from(chunk).toString('base64') },
        });
        sentMs += chunk.length / 8;
        offset = (offset + chunk.length) % music.mulaw.length;
      }
      timer = setTimeout(pump, 200);
    };
    stopMusic = () => {
      clearTimeout(timer);
      stopMusic = undefined;
      send(caller, { event: 'clear', streamSid });
    };
    pump();
  };

  const switchToAi = () => {
    log('relay.switch_requested', { call: callId });
    const sid = legSid;
    // The interpreter hears a short notice, then their leg hangs up.
    if (sid !== undefined) {
      void (phase === 'connected'
        ? rest.updateCall(sid, options.releaseTwiml)
        : rest.endCall(sid));
    }
    finish('switch_to_ai', 'switch_to_ai');
  };

  const attachLeg: LegAttach = (socket, sid) => {
    if (phase !== 'ringing') {
      return false;
    }
    phase = 'connected';
    leg = socket;
    legStreamSid = sid;
    connectedAt = Date.now();
    hub.stopWaiting(callSid);
    stopMusic?.();
    log('relay.connected', {
      call: callId,
      answerSeconds: Math.round((connectedAt - ringStartedAt) / 1000),
    });
    if (limitMs > 0) {
      later(limitMs, () => {
        if (legSid !== undefined) {
          void rest.endCall(legSid);
        }
        finish('time_limit', 'time_limit');
      });
    }
    socket.on('message', (data, isBinary) => {
      const message = parse(data, isBinary);
      if (message === undefined || phase !== 'connected') {
        return;
      }
      if (message['event'] === 'media') {
        const payload = mediaPayload(message);
        if (payload !== undefined) {
          send(caller, { event: 'media', streamSid, media: { payload } });
        }
      } else if (message['event'] === 'stop') {
        finish('interpreter_ended', 'interpreter_ended');
      }
    });
    socket.on('close', () => finish('interpreter_ended', 'interpreter_ended'));
    socket.on('error', () => undefined);
    return true;
  };

  /** Ring the interpreter line; watch it until it answers or gives up. */
  const ring = async (calledNumber: string, lang: string | undefined) => {
    const company = options.companies?.byTwilioNumber(calledNumber);
    const target =
      company?.humanNumber ??
      (lang === undefined ? undefined : config.humanNumbers[lang]?.[0]) ??
      config.humanNumbers['default']?.[0];
    if (target === undefined) {
      finish('no_target', 'no_answer');
      return;
    }
    const legTwiml = response(
      element(
        'Connect',
        {},
        element(
          'Stream',
          { url: `${config.publicBaseUrl.replace(/^http/, 'ws')}/relay-leg` },
          element('Parameter', { name: 'parent', value: callSid }),
        ),
      ),
    );
    phase = 'ringing';
    ringStartedAt = Date.now();
    hub.wait(callSid, attachLeg);
    startMusic();
    later(timing.ringTimeoutMs, () => {
      if (phase === 'ringing') {
        if (legSid !== undefined) {
          void rest.endCall(legSid);
        }
        finish('ring_timeout', 'no_answer');
      }
    });
    legSid = await rest.createCall({
      to: target,
      from: calledNumber,
      twiml: legTwiml,
      timeoutSeconds: Math.ceil(timing.ringTimeoutMs / 1000) - 5,
    });
    if (phase !== 'ringing') {
      // The caller left, or switched, while the call was being placed.
      if (legSid !== undefined) {
        void rest.endCall(legSid);
      }
      return;
    }
    if (legSid === undefined) {
      finish('dial_failed', 'no_answer');
      return;
    }
    log('relay.ringing', { call: callId });
    const poll = async () => {
      if (phase !== 'ringing' || legSid === undefined) {
        return;
      }
      const info = await rest.getCall(legSid);
      if (phase !== 'ringing') {
        return;
      }
      if (info !== undefined && NOT_ANSWERED.has(info.status)) {
        finish(`leg_${info.status}`, 'no_answer');
        return;
      }
      later(timing.pollMs, () => void poll());
    };
    later(timing.pollMs, () => void poll());
  };

  const onStart = async (start: Json) => {
    const sid = start['callSid'];
    callId = typeof sid === 'string' ? redactId(sid) : 'unknown';
    streamSid =
      typeof start['streamSid'] === 'string' ? start['streamSid'] : '';
    if (start['accountSid'] !== config.twilioAccountSid) {
      finish('wrong_account');
      return;
    }
    if (!isCallSid(sid) || streamSid === '') {
      finish('invalid_parameters');
      return;
    }
    callSid = sid;
    const params = isJson(start['customParameters'])
      ? start['customParameters']
      : {};
    switchAllowed = params['switch'] === '1';
    const limit = Number(params['limit']);
    limitMs =
      Number.isInteger(limit) && limit >= 60 && limit <= 4 * 3600
        ? limit * 1000
        : 0;
    const lang =
      typeof params['lang'] === 'string' && params['lang'] !== ''
        ? params['lang']
        : undefined;
    log('relay.started', { call: callId });
    // The number the caller dialed: the company's line, and the caller ID
    // the interpreter line sees.
    const info = await rest.getCall(callSid);
    if (phase !== 'starting') {
      return;
    }
    if (info === undefined || info.to === '') {
      finish('call_lookup_failed', 'no_answer');
      return;
    }
    await ring(info.to, lang);
  };

  later(timing.startTimeoutMs, () => {
    if (phase === 'starting' && callSid === '') {
      finish('no_start');
    }
  });

  caller.on('message', (data, isBinary) => {
    const message = parse(data, isBinary);
    if (message === undefined || phase === 'done') {
      return;
    }
    switch (message['event']) {
      case 'start':
        if (callSid === '' && isJson(message['start'])) {
          void onStart(message['start']);
        }
        break;
      case 'media':
        if (phase === 'connected') {
          const payload = mediaPayload(message);
          if (payload !== undefined) {
            send(leg, {
              event: 'media',
              streamSid: legStreamSid,
              media: { payload },
            });
          }
        }
        break;
      case 'dtmf': {
        const dtmf = message['dtmf'];
        const digit =
          isJson(dtmf) && typeof dtmf['digit'] === 'string'
            ? dtmf['digit']
            : '';
        if (digit.length !== 1) {
          break;
        }
        if (switchAllowed && keys.press(digit)) {
          switchToAi();
          break;
        }
        // Everything else reaches the interpreter line's own menu as a tone.
        if (phase === 'connected') {
          send(leg, {
            event: 'media',
            streamSid: legStreamSid,
            media: { payload: Buffer.from(dtmfTone(digit)).toString('base64') },
          });
        }
        break;
      }
      case 'stop':
        if (legSid !== undefined) {
          void rest.endCall(legSid);
        }
        finish('caller_left');
        break;
      default:
        break;
    }
  });
  caller.on('close', () => {
    if (phase !== 'done' && legSid !== undefined) {
      void rest.endCall(legSid);
    }
    finish('caller_closed');
  });
  caller.on('error', () => undefined);
}

/**
 * The interpreter's side (/relay-leg): hands its stream to the waiting
 * caller, or closes if none waits (a late answer after the caller left).
 */
export function runRelayLeg(
  leg: WebSocket,
  options: { accountSid: string; hub: RelayHub },
): void {
  let handled = false;
  const timer = setTimeout(() => {
    if (!handled) {
      leg.close(1000);
    }
  }, START_TIMEOUT_MS);
  const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    const message = parse(data, isBinary);
    if (
      handled ||
      message?.['event'] !== 'start' ||
      !isJson(message['start'])
    ) {
      return;
    }
    handled = true;
    clearTimeout(timer);
    leg.off('message', onMessage);
    const start = message['start'];
    const params = isJson(start['customParameters'])
      ? start['customParameters']
      : {};
    const parent = params['parent'];
    const sid = start['streamSid'];
    if (
      start['accountSid'] !== options.accountSid ||
      !isCallSid(parent) ||
      typeof sid !== 'string' ||
      !options.hub.attach(parent, leg, sid)
    ) {
      log('relay.leg_refused', {
        call: isCallSid(parent) ? redactId(parent) : 'unknown',
      });
      leg.close(1000);
    }
  };
  leg.on('message', onMessage);
  leg.on('close', () => clearTimeout(timer));
  leg.on('error', () => undefined);
}

/**
 * One phone call: a Twilio bidirectional Media Stream bridged to one
 * FourPoints session, under half-duplex floor control.
 *
 * All state for the call lives in this closure and dies with the Twilio
 * socket. Nothing is shared between calls or between gateway instances, so
 * capacity is simply instances × MAX_CALLS.
 */

import type WebSocket from 'ws';

import type { ServerMessage } from '@fourpoints/protocol';

import {
  CUES,
  Downsampler2x,
  TELEPHONY_RATE_HZ,
  Upsampler2x,
  decodeMulaw,
  encodeMulaw,
  int16FromBytes,
} from './audio.js';
import type { TelephonyConfig } from './config.js';
import { Floor } from './floor.js';
import {
  FourPointsSession,
  type FourPointsTarget,
  type LanguagePair,
} from './fourpoints.js';
import { KeySequence } from './key-sequence.js';
import { findByLanguage, type LanguageMenu } from './languages.js';
import { log, redactId } from './log.js';
import type { PromptClip, PromptLibrary } from './prompts.js';
import { EnergyVad } from './vad.js';

/** Twilio must send `start` promptly after connecting. */
const START_TIMEOUT_MS = 5_000;
/** FourPoints caps a session at 200 turns; rotate before reaching it. */
const MAX_TURNS_PER_SESSION = 190;
/** Recorded audio goes to Twilio in 200 ms messages. */
const CLIP_CHUNK_BYTES = 1600;
/** Hold music starts only if FourPoints is still not ready this long after the greeting. */
const HOLD_MUSIC_DELAY_MS = 400;
/** Hold music is kept this far ahead of playback, so stopping it is near-instant. */
const HOLD_MUSIC_LEAD_MS = 1_000;
/** Never wait on a greeting's mark longer than its length plus this. */
const GREETING_MARK_SLACK_MS = 3_000;
const GREETING_MARK = 'greeting';
/** Said before the stream closes on a failure; /voice/ai-ended then dials a human. */
const UNAVAILABLE_CLIP = 'ai-unavailable';

export interface CallOptions {
  config: TelephonyConfig;
  target: FourPointsTarget;
  menu: () => LanguageMenu;
  /** Recorded greeting and hold music; without them the stream starts silent. */
  prompts?: PromptLibrary;
  onEnd: () => void;
}

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null;

export function runCall(twilio: WebSocket, options: CallOptions): void {
  const { config } = options;
  let streamSid = '';
  let callId = 'unknown';
  let pair: LanguagePair | undefined;
  let session: FourPointsSession | undefined;
  let opening: Promise<boolean> | undefined;
  let ended = false;
  let speechOpen = false; // an accepted tts utterance is streaming
  let pendingMarks = 0;
  let markCount = 0;
  // ### hands the call to a human, when the IVR allowed it (`transfer`).
  let transferAllowed = false;
  const switchKeys = new KeySequence();
  const upsampler = new Upsampler2x();
  const downsampler = new Downsampler2x();

  const toTwilio = (message: Json) => {
    if (twilio.readyState === twilio.OPEN) {
      twilio.send(JSON.stringify(message));
    }
  };
  const play = (mulaw: Uint8Array) =>
    toTwilio({
      event: 'media',
      streamSid,
      media: {
        payload: Buffer.from(
          mulaw.buffer,
          mulaw.byteOffset,
          mulaw.byteLength,
        ).toString('base64'),
      },
    });
  const playClip = (mulaw: Uint8Array) => {
    for (let i = 0; i < mulaw.length; i += CLIP_CHUNK_BYTES) {
      play(mulaw.subarray(i, i + CLIP_CHUNK_BYTES));
    }
  };
  // The greeting's own mark; the floor's marks are counted separately.
  let greetingPlayed: (() => void) | undefined;
  let stopHoldMusic: (() => void) | undefined;
  // Twilio echoes a mark once everything queued before it has played.
  const mark = () => {
    pendingMarks += 1;
    markCount += 1;
    toTwilio({ event: 'mark', streamSid, mark: { name: `m${markCount}` } });
  };

  const floor = new Floor(new EnergyVad(TELEPHONY_RATE_HZ, config.vad), {
    startTurn: (speaker) => {
      upsampler.reset();
      session?.startTurn(speaker, config.detectSpeakerLanguage);
    },
    sendAudio: (samples) =>
      session?.sendAudio(
        config.inputSampleRateHz === 16000
          ? upsampler.process(samples)
          : samples,
      ),
    endTurn: () => session?.endTurn(),
    playCue: (cue) => {
      play(CUES[cue]);
      mark();
    },
    isPlaybackIdle: () => pendingMarks === 0 && !speechOpen,
    beforeListening: (resume) => {
      void ensureSession().then((ok) =>
        ok ? resume() : failStream('fourpoints_unavailable'),
      );
    },
    schedule: (callback, delayMs) => {
      const id = setTimeout(callback, delayMs);
      return () => clearTimeout(id);
    },
  });

  const onFourPointsMessage = (message: ServerMessage) => {
    switch (message.type) {
      case 'tts.started': {
        const { encoding, sampleRateHz } = message.audioFormat;
        speechOpen =
          floor.acceptsSpeech &&
          encoding === 'pcm_s16le' &&
          sampleRateHz === 16000;
        if (floor.acceptsSpeech && !speechOpen) {
          log('call.unsupported_speech_format', { call: callId, sampleRateHz });
        }
        downsampler.reset();
        break;
      }
      case 'tts.ended':
        if (speechOpen) {
          speechOpen = false;
          mark();
        }
        break;
      case 'turn.speaker':
        // Which participant actually spoke (no content is logged).
        log('call.speaker_switched', { call: callId });
        floor.speakerConfirmed(message.speaker);
        break;
      case 'metrics.turn':
        floor.turnFinished();
        break;
      case 'warning':
      case 'error':
        log('fourpoints.problem', {
          call: callId,
          type: message.type,
          category: message.category,
        });
        floor.turnFailed();
        break;
      default:
        break; // transcripts and translations are not used here and never logged
    }
  };

  const onSpeechAudio = (pcm: Uint8Array) => {
    if (!speechOpen) {
      return;
    }
    const mulaw = encodeMulaw(downsampler.process(int16FromBytes(pcm)));
    if (mulaw.length > 0) {
      play(mulaw);
      floor.speechStarted();
    }
  };

  /** Open, or rotate, the FourPoints session. Resolves false if unavailable. */
  const ensureSession = (): Promise<boolean> => {
    if (
      session !== undefined &&
      session.isOpen &&
      session.ageMs < config.sessionRotateAfterMs &&
      session.turnCount < MAX_TURNS_PER_SESSION
    ) {
      return Promise.resolve(true);
    }
    opening ??= (async () => {
      const previous = session;
      try {
        if (pair === undefined) {
          return false;
        }
        const opened: FourPointsSession = await FourPointsSession.open(
          options.target,
          pair,
          config.inputSampleRateHz,
          {
            onMessage: (message) =>
              session === opened && onFourPointsMessage(message),
            onSpeechAudio: (pcm) => session === opened && onSpeechAudio(pcm),
            onClosed: () => {
              if (session === opened && !ended) {
                log('fourpoints.session_lost', { call: callId });
                floor.abortTurn();
              }
            },
          },
        );
        if (ended) {
          opened.close();
          return false;
        }
        session = opened;
        previous?.close();
        log('fourpoints.session_opened', {
          call: callId,
          rotated: previous !== undefined,
        });
        return true;
      } catch (error) {
        log('fourpoints.session_failed', {
          call: callId,
          reason: error instanceof Error ? error.message : 'unknown',
        });
        return false;
      } finally {
        opening = undefined;
      }
    })();
    return opening;
  };

  /** Close the stream; TwiML continues at <Connect action> (human fallback). */
  const endStream = (reason: string) => {
    log('call.stream_closed_by_gateway', { call: callId, reason });
    twilio.close(1000);
    endCall(reason);
  };

  /**
   * The AI cannot go on: say so, then close (the caller reaches a human).
   * /voice/ai-ended no longer says it, since a ### close reaches it too.
   */
  const failStream = (reason: string) => {
    const clip = options.prompts?.clip(UNAVAILABLE_CLIP);
    if (clip === undefined || ended) {
      endStream(reason);
      return;
    }
    floor.stop();
    void playGreeting(clip).then(() => {
      if (!ended) {
        endStream(reason);
      }
    });
  };

  const endCall = (reason: string) => {
    if (ended) {
      return;
    }
    ended = true;
    clearTimeout(startTimer);
    stopHoldMusic?.();
    greetingPlayed?.();
    floor.stop();
    session?.close();
    session = undefined;
    log('call.ended', { call: callId, reason });
    options.onEnd();
  };

  const onStart = async (start: Json) => {
    const params = isJson(start['customParameters'])
      ? start['customParameters']
      : {};
    const patient = findByLanguage(
      options.menu(),
      typeof params['patientLanguageId'] === 'string'
        ? params['patientLanguageId']
        : null,
    );
    streamSid =
      typeof start['streamSid'] === 'string' ? start['streamSid'] : '';
    callId =
      typeof start['callSid'] === 'string'
        ? redactId(start['callSid'])
        : 'unknown';
    if (start['accountSid'] !== config.twilioAccountSid) {
      endStream('wrong_account');
      return;
    }
    if (
      streamSid === '' ||
      patient === undefined ||
      params['clinicianLanguageId'] !== config.clinicianLanguageId
    ) {
      endStream('invalid_parameters');
      return;
    }
    pair = {
      clinicianLanguageId: config.clinicianLanguageId,
      patientLanguageId: patient.languageId,
    };
    transferAllowed = params['transfer'] === '1';
    log('call.started', {
      call: callId,
      patientLanguageId: patient.languageId,
    });
    // The FourPoints session opens while the greeting plays: the caller
    // hears the greeting instead of silence, and the first tone follows it
    // as soon as both are done.
    const ready = ensureSession();
    const greetingId = params['greeting'];
    const greeting =
      typeof greetingId === 'string' && greetingId.startsWith('ai-connected-')
        ? options.prompts?.clip(greetingId)
        : undefined;
    if (greeting !== undefined) {
      await playGreeting(greeting);
    }
    const ok = await holdMusicUntil(ready);
    if (ended) {
      return;
    }
    if (ok) {
      floor.start();
    } else {
      failStream('fourpoints_unavailable');
    }
  };

  /** Play a recorded prompt; resolves once Twilio reports it played (or the call ends). */
  const playGreeting = (greeting: PromptClip): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(
        () => greetingPlayed?.(),
        greeting.mulaw.length / 8 + GREETING_MARK_SLACK_MS,
      );
      greetingPlayed = () => {
        clearTimeout(timer);
        greetingPlayed = undefined;
        resolve();
      };
      playClip(greeting.mulaw);
      toTwilio({ event: 'mark', streamSid, mark: { name: GREETING_MARK } });
    });

  /**
   * Loop hold music until `ready` settles, unless it settles within
   * HOLD_MUSIC_DELAY_MS. Music is paced a second ahead of playback and
   * cut with `clear`, so the first tone is never late behind queued music.
   */
  const holdMusicUntil = async (ready: Promise<boolean>): Promise<boolean> => {
    const music = options.prompts?.clip('hold-music');
    let settled = false;
    const watched = ready.finally(() => {
      settled = true;
    });
    if (music === undefined || music.mulaw.length === 0) {
      return watched;
    }
    await Promise.race([
      watched,
      new Promise((resolve) => setTimeout(resolve, HOLD_MUSIC_DELAY_MS)),
    ]);
    if (settled || ended) {
      return watched;
    }
    log('call.hold_music', { call: callId });
    const started = Date.now();
    let sentMs = 0;
    let offset = 0;
    let timer: NodeJS.Timeout | undefined;
    const pump = () => {
      while (sentMs < Date.now() - started + HOLD_MUSIC_LEAD_MS) {
        const chunk = music.mulaw.subarray(offset, offset + CLIP_CHUNK_BYTES);
        play(chunk);
        sentMs += chunk.length / 8;
        offset = (offset + chunk.length) % music.mulaw.length;
      }
      timer = setTimeout(pump, 200);
    };
    stopHoldMusic = () => {
      clearTimeout(timer);
      stopHoldMusic = undefined;
      toTwilio({ event: 'clear', streamSid });
    };
    pump();
    try {
      return await watched;
    } finally {
      stopHoldMusic?.();
    }
  };

  const startTimer = setTimeout(() => endStream('no_start'), START_TIMEOUT_MS);

  twilio.on('message', (data, isBinary) => {
    if (isBinary || ended) {
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
        if (streamSid === '' && isJson(message['start'])) {
          clearTimeout(startTimer);
          void onStart(message['start']);
        }
        break;
      case 'media': {
        const media = message['media'];
        if (
          session !== undefined &&
          isJson(media) &&
          typeof media['payload'] === 'string' &&
          (media['track'] === undefined || media['track'] === 'inbound')
        ) {
          floor.audio(decodeMulaw(Buffer.from(media['payload'], 'base64')));
        }
        break;
      }
      case 'dtmf': {
        const dtmf = message['dtmf'];
        if (isJson(dtmf) && typeof dtmf['digit'] === 'string') {
          if (switchKeys.press(dtmf['digit'])) {
            if (transferAllowed) {
              // A half-captured turn (key tones included) dies with the
              // session; nothing is translated.
              endStream('transfer_requested');
            } else {
              play(CUES.repeat);
              mark();
            }
            break;
          }
          floor.dtmf(dtmf['digit']);
        }
        break;
      }
      case 'mark': {
        const name = isJson(message['mark']) ? message['mark']['name'] : '';
        if (name === GREETING_MARK) {
          greetingPlayed?.();
          break;
        }
        pendingMarks = Math.max(0, pendingMarks - 1);
        floor.playbackDrained();
        break;
      }
      case 'stop':
        endCall('twilio_stop');
        break;
      default:
        break;
    }
  });
  twilio.on('close', () => endCall('twilio_closed'));
  twilio.on('error', () => undefined); // 'close' follows
}

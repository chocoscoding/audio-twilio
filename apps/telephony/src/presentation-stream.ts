/**
 * Presentation-mode media stream. Instead of bridging to FourPoints, the
 * gateway plays the caller's own words back to them, so both directions of
 * the Twilio audio path are audible — and every step is written to
 * stream.log in plain English.
 *
 *   beep ─► listen ─► caller speaks ─► silence ─► send the recording back ─► beep …
 *
 * Half-duplex like the real call: while audio plays, caller audio is ignored.
 */

import type WebSocket from 'ws';

import { CUES, TELEPHONY_RATE_HZ, decodeMulaw, encodeMulaw } from './audio.js';
import type { TelephonyConfig } from './config.js';
import { findByLanguage, type LanguageMenu } from './languages.js';
import { log, redactId } from './log.js';
import { highlight, problem, shortSid, streamLog } from './presentation-log.js';
import { EnergyVad, rmsOf } from './vad.js';

const START_TIMEOUT_MS = 5_000;
/** Twilio sends 20 ms of 8 kHz μ-law per media message: 160 bytes. */
const FRAME_BYTES = 160;
const MAX_RECORDING_MS = 10_000;

export interface PresentationStreamOptions {
  config: TelephonyConfig;
  menu: () => LanguageMenu;
  onEnd: () => void;
}

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null;

const seconds = (bytes: number) =>
  `${(bytes / TELEPHONY_RATE_HZ).toFixed(1)} s`;

/** A 10-step loudness bar for one second of audio. */
function meter(rms: number): string {
  const level =
    rms <= 0
      ? 0
      : Math.max(
          0,
          Math.min(10, Math.round(((20 * Math.log10(rms) + 60) / 60) * 10)),
        );
  return `${'█'.repeat(level)}${'░'.repeat(10 - level)}`;
}

const preview = (message: Json) => {
  const text = JSON.stringify(message);
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
};

export function runPresentationStream(
  twilio: WebSocket,
  options: PresentationStreamOptions,
): void {
  const { config } = options;
  let streamSid = '';
  let callId = 'unknown';
  let ended = false;
  let listening = false;
  let replies = 0;
  let recording: Int16Array[] | undefined;

  // Totals, and a one-second window for the "audio arriving" line.
  let packetsIn = 0;
  let packetsOut = 0;
  let windowPackets = 0;
  let windowBytes = 0;
  let windowSquares = 0;
  let windowSamples = 0;
  let firstMediaShown = false;

  const vad = new EnergyVad(TELEPHONY_RATE_HZ, {
    ...config.vad,
    hangoverMs: 700,
    maxTurnMs: MAX_RECORDING_MS,
  });
  vad.suspend();

  const send = (message: Json) => {
    if (twilio.readyState === twilio.OPEN) {
      twilio.send(JSON.stringify(message));
    }
  };

  /** Send μ-law audio as 20 ms media messages, followed by a mark. */
  const play = (mulaw: Uint8Array, markName: string, what: string) => {
    let frames = 0;
    for (let at = 0; at < mulaw.length; at += FRAME_BYTES) {
      const message = {
        event: 'media',
        streamSid,
        media: {
          payload: Buffer.from(mulaw.subarray(at, at + FRAME_BYTES)).toString(
            'base64',
          ),
        },
      };
      if (packetsOut === 0) {
        streamLog(
          'out',
          'first "media" message sent back (this is what audio to Twilio looks like):',
          preview(message),
        );
      }
      send(message);
      frames += 1;
      packetsOut += 1;
    }
    send({ event: 'mark', streamSid, mark: { name: markName } });
    streamLog(
      'out',
      `${highlight('media')}  ${what}: ${frames} packets · ${mulaw.length.toLocaleString()} bytes · ${seconds(mulaw.length)}`,
      `then "mark" ${markName} — Twilio returns it when the caller has heard this`,
    );
  };

  const beep = () => {
    listening = false;
    vad.suspend();
    play(CUES.clinician, 'beep', 'beep tone');
  };

  const flushWindow = () => {
    if (windowPackets === 0) {
      return;
    }
    const rms = Math.sqrt(windowSquares / Math.max(1, windowSamples)) / 32768;
    streamLog(
      'in',
      `${highlight('media')}  ${String(windowPackets).padStart(3)} packets · ${windowBytes.toLocaleString()} bytes · level ${meter(rms)}  ${listening ? '(listening)' : '(ignored while audio plays)'}`,
    );
    windowPackets = 0;
    windowBytes = 0;
    windowSquares = 0;
    windowSamples = 0;
  };
  const windowTimer = setInterval(flushWindow, 1000);

  const endCall = (reason: string) => {
    if (ended) {
      return;
    }
    ended = true;
    clearTimeout(startTimer);
    clearInterval(windowTimer);
    flushWindow();
    streamLog(
      'note',
      `${highlight('Stream closed')} (${reason}) — received ${packetsIn} packets (${seconds(packetsIn * FRAME_BYTES)}), sent ${packetsOut} packets`,
    );
    log('presentation.stream_ended', {
      call: callId,
      reason,
      packetsIn,
      packetsOut,
    });
    options.onEnd();
  };

  const endStream = (reason: string) => {
    streamLog('note', problem(`Gateway closes the stream: ${reason}`));
    twilio.close(1000);
    endCall(reason);
  };

  const onStart = (message: Json, start: Json) => {
    const params = isJson(start['customParameters'])
      ? start['customParameters']
      : {};
    const format = isJson(start['mediaFormat']) ? start['mediaFormat'] : {};
    const language = findByLanguage(
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
    streamLog(
      'in',
      `${highlight('"start"')}  stream ${shortSid(streamSid)} for call ${shortSid(start['callSid'] as string)}`,
      `audio format: ${String(format['encoding'])}, ${String(format['sampleRate'])} Hz, ${String(format['channels'])} channel · tracks: ${JSON.stringify(start['tracks'])}`,
      `parameters from TwiML: ${JSON.stringify(params)}`,
      preview(message),
    );
    if (start['accountSid'] !== config.twilioAccountSid) {
      endStream('wrong Twilio account');
      return;
    }
    if (streamSid === '' || language === undefined) {
      endStream('unknown language');
      return;
    }
    streamLog(
      'note',
      `${highlight(`${language.displayName} language stream`)} is live`,
    );
    log('presentation.stream_started', {
      call: callId,
      language: language.languageId,
    });
    beep();
  };

  const onAudio = (payload: string) => {
    const mulaw = Buffer.from(payload, 'base64');
    const samples = decodeMulaw(mulaw);
    packetsIn += 1;
    windowPackets += 1;
    windowBytes += mulaw.length;
    for (const sample of samples) {
      windowSquares += sample * sample;
    }
    windowSamples += samples.length;
    if (!listening) {
      return;
    }
    recording?.push(samples);
    const event = vad.push(samples);
    if (event?.type === 'speech-start') {
      recording = event.preroll; // already ends with this chunk
      streamLog('note', highlight('Caller started speaking — recording'));
    } else if (event?.type === 'speech-end' && recording !== undefined) {
      const total = recording.reduce((sum, part) => sum + part.length, 0);
      const all = new Int16Array(total);
      let at = 0;
      for (const part of recording) {
        all.set(part, at);
        at += part.length;
      }
      recording = undefined;
      listening = false;
      vad.suspend();
      streamLog(
        'note',
        `${highlight('Caller stopped speaking')} — ${seconds(total)} recorded (loudness ${meter(rmsOf(all))})`,
      );
      replies += 1;
      play(
        encodeMulaw(all),
        `reply-${replies}`,
        'sending the caller’s words back',
      );
    }
  };

  const startTimer = setTimeout(
    () => endStream('Twilio sent no "start" within 5 s'),
    START_TIMEOUT_MS,
  );

  streamLog(
    'note',
    `${highlight('WebSocket opened')} by Twilio on /media (signature verified)`,
  );

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
      case 'connected':
        streamLog(
          'in',
          `${highlight('"connected"')}  protocol ${String(message['protocol'])} v${String(message['version'])}`,
          preview(message),
        );
        break;
      case 'start':
        if (streamSid === '' && isJson(message['start'])) {
          clearTimeout(startTimer);
          onStart(message, message['start']);
        }
        break;
      case 'media': {
        const media = message['media'];
        if (isJson(media) && typeof media['payload'] === 'string') {
          if (!firstMediaShown) {
            firstMediaShown = true;
            streamLog(
              'in',
              'first "media" message (the caller’s voice, 20 ms per message):',
              preview(message),
            );
          }
          onAudio(media['payload']);
        }
        break;
      }
      case 'mark': {
        const mark = message['mark'];
        const name = isJson(mark) ? String(mark['name']) : '?';
        if (name === 'beep') {
          streamLog(
            'in',
            `${highlight('"mark"')} beep — beep finished playing`,
          );
          streamLog('note', highlight('Listening… say something'));
          listening = true;
          vad.resume();
        } else {
          streamLog(
            'in',
            `${highlight('"mark"')} ${name} — the caller has heard it`,
          );
          beep();
        }
        break;
      }
      case 'dtmf': {
        const dtmf = message['dtmf'];
        streamLog(
          'in',
          `${highlight('"dtmf"')}  caller pressed ${isJson(dtmf) ? String(dtmf['digit']) : '?'}`,
        );
        break;
      }
      case 'stop':
        flushWindow();
        streamLog(
          'in',
          `${highlight('"stop"')}  Twilio ended the stream`,
          preview(message),
        );
        endCall('caller hung up');
        break;
      default:
        break;
    }
  });
  twilio.on('close', () => endCall('WebSocket closed'));
  twilio.on('error', () => undefined); // 'close' follows
}

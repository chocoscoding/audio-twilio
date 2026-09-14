/**
 * Dev harness (not part of the image): plays Twilio's role against a running
 * gateway, so the whole path runs locally with no phone and no Twilio spend:
 *
 *   this script → gateway /media → FourPoints realtime → gateway → this script
 *
 * Usage (synthetic speech only):
 *   node --env-file=apps/telephony/.env apps/telephony/dist/fake-twilio-call.js \
 *     <speech.wav> [--lang es-US] [--speaker clinician|patient] \
 *     [--gateway ws://localhost:8080] [--save translation.wav]
 *
 * <speech.wav> is mono 16-bit PCM at 8 or 16 kHz, spoken in the speaker's
 * language. The handshake is signed with TWILIO_AUTH_TOKEN / PUBLIC_BASE_URL
 * from the environment, exactly as Twilio would sign it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import WebSocket from 'ws';

import {
  Downsampler2x,
  decodeMulaw,
  encodeMulaw,
  int16FromBytes,
} from './audio.js';
import { twilioSignature } from './twilio-signature.js';

const FRAME_BYTES = 160; // 20 ms of μ-law at 8 kHz
const TIMEOUT_MS = 90_000;
const LISTEN_DELAY_MS = 1_000; // handoff guard + VAD calibration, with margin
const MIN_TRANSLATION_MS = 400; // longer than any cue tone

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lang: { type: 'string', default: 'es-US' },
    speaker: { type: 'string', default: 'clinician' },
    gateway: { type: 'string', default: 'ws://localhost:8080' },
    save: { type: 'string' },
  },
});

function readWav(path: string): Int16Array {
  const buf = readFileSync(path);
  if (
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${path} is not a WAV file`);
  }
  let rate = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      const [format, channels, bits] = [
        buf.readUInt16LE(body),
        buf.readUInt16LE(body + 2),
        buf.readUInt16LE(body + 14),
      ];
      rate = buf.readUInt32LE(body + 4);
      if (
        format !== 1 ||
        channels !== 1 ||
        bits !== 16 ||
        (rate !== 8000 && rate !== 16000)
      ) {
        throw new Error('expected mono 16-bit PCM at 8000 or 16000 Hz');
      }
    } else if (id === 'data') {
      const pcm = int16FromBytes(buf.subarray(body, body + size));
      return rate === 16000 ? new Downsampler2x().process(pcm) : pcm;
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

function toWav(pcm: Int16Array, rateHz: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rateHz, 24);
  header.writeUInt32LE(rateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([
    header,
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
  ]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<boolean> {
  const wavPath = positionals[0];
  if (
    wavPath === undefined ||
    (values.speaker !== 'clinician' && values.speaker !== 'patient')
  ) {
    console.error(
      'usage: fake-twilio-call <speech.wav> [--lang es-US] [--speaker clinician|patient] [--gateway ws://localhost:8080] [--save out.wav]',
    );
    return false;
  }
  const speech = encodeMulaw(readWav(wavPath));
  const token = process.env['TWILIO_AUTH_TOKEN'];
  const publicBase = process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '');
  const headers =
    token !== undefined && publicBase !== undefined
      ? {
          'x-twilio-signature': twilioSignature(
            token,
            `${publicBase.replace(/^http/, 'ws')}/media`,
          ),
        }
      : undefined;

  const ws = new WebSocket(
    `${values.gateway}/media`,
    headers === undefined ? {} : { headers },
  );
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const outgoing: Uint8Array[] = [];
  let received: Uint8Array[] = [];
  let playoutEndsAt = 0;
  let markWaiter: (() => void) | undefined;
  const send = (message: object) => ws.send(JSON.stringify(message));

  // Twilio streams caller audio continuously: queued speech, else silence.
  const ticker = setInterval(() => {
    const frame = outgoing.shift() ?? new Uint8Array(FRAME_BYTES).fill(0xff);
    send({
      event: 'media',
      streamSid: 'MZfake',
      media: {
        track: 'inbound',
        payload: Buffer.from(frame).toString('base64'),
      },
    });
  }, 20);

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      event?: string;
      media?: { payload: string };
      mark?: { name: string };
    };
    if (message.event === 'media' && message.media !== undefined) {
      const bytes = Buffer.from(message.media.payload, 'base64');
      received.push(bytes);
      playoutEndsAt = Math.max(Date.now(), playoutEndsAt) + bytes.length / 8;
    } else if (message.event === 'mark' && message.mark !== undefined) {
      const name = message.mark.name;
      // Echo once the audio queued before the mark has "played".
      setTimeout(
        () => {
          send({ event: 'mark', streamSid: 'MZfake', mark: { name } });
          markWaiter?.();
        },
        Math.max(0, playoutEndsAt - Date.now()),
      );
    }
  });
  const playedMark = () =>
    new Promise<void>((resolve) => (markWaiter = resolve));

  send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  send({
    event: 'start',
    streamSid: 'MZfake',
    start: {
      accountSid: process.env['TWILIO_ACCOUNT_SID'] ?? '',
      streamSid: 'MZfake',
      callSid: `CAfake${Date.now()}`,
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: {
        clinicianLanguageId: process.env['CLINICIAN_LANGUAGE_ID'] ?? 'en-US',
        patientLanguageId: values.lang,
      },
    },
  });

  const run = async (): Promise<boolean> => {
    await playedMark(); // clinician cue
    if (values.speaker === 'patient') {
      send({
        event: 'dtmf',
        streamSid: 'MZfake',
        dtmf: { track: 'inbound_track', digit: '*' },
      });
      await playedMark(); // patient cue
    }
    await sleep(LISTEN_DELAY_MS);
    for (let at = 0; at < speech.length; at += FRAME_BYTES) {
      outgoing.push(speech.subarray(at, at + FRAME_BYTES));
    }
    console.log(
      `speaking ${((speech.length / 8000) * 1000).toFixed(0)} ms as ${values.speaker}…`,
    );
    while (outgoing.length > 0) {
      await sleep(20);
    }
    received = [];
    await playedMark(); // translation (or a "please repeat" cue)
    const pcm = decodeMulaw(Buffer.concat(received));
    const ms = (pcm.length / 8000) * 1000;
    console.log(`heard ${ms.toFixed(0)} ms of audio back`);
    if (values.save !== undefined) {
      writeFileSync(values.save, toWav(pcm, 8000));
      console.log(`saved to ${values.save} (dev listening only)`);
    }
    return ms >= MIN_TRANSLATION_MS;
  };

  const ok = await Promise.race([run(), sleep(TIMEOUT_MS).then(() => false)]);
  clearInterval(ticker);
  send({ event: 'stop', streamSid: 'MZfake', stop: {} });
  ws.close();
  console.log(
    ok ? 'fake call PASS: translated speech played back' : 'fake call FAIL',
  );
  return ok;
}

process.exit((await main()) ? 0 : 1);

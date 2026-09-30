/**
 * Presentation mode end to end, in process: a fake Twilio media stream →
 * the real gateway, which beeps, records the caller and plays it back.
 */

import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { encodeMulaw } from './audio.js';
import { loadConfig } from './config.js';
import { staticMenu } from './languages.js';
import { describeTwiml } from './presentation-log.js';
import { createTelephonyServer, type TelephonyServer } from './server.js';
import { twilioSignature } from './twilio-signature.js';

const TOKEN = 'test-auth-token';
const ACCOUNT_SID = `AC${'1'.repeat(32)}`;

/** 20 ms of μ-law at 8 kHz: a tone for speech, digital silence otherwise. */
function mulawFrame(speech: boolean, offset: number): string {
  const pcm = Int16Array.from({ length: 160 }, (_, i) =>
    speech
      ? Math.round(
          0.3 * 32767 * Math.sin((2 * Math.PI * 440 * (offset + i)) / 8000),
        )
      : 0,
  );
  return Buffer.from(encodeMulaw(pcm)).toString('base64');
}

describe('presentation media stream (integration)', () => {
  let gateway: TelephonyServer;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const config = loadConfig({
      PORT: '0',
      PUBLIC_BASE_URL: 'http://gateway.test',
      TWILIO_ACCOUNT_SID: ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: TOKEN,
      PRESENTATION_MODE: 'true',
      PRESENTATION_LANGUAGES: 'Spanish',
    });
    const menu = staticMenu(config.presentationLanguages);
    gateway = await createTelephonyServer({
      config,
      target: { url: 'ws://unused.invalid', authHeaders: () => ({}) },
      menu: () => menu,
    });
  });

  afterEach(async () => {
    await gateway.close(0);
    vi.restoreAllMocks();
  });

  it('beeps, records the caller, and plays the recording back', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/media`, {
      headers: {
        'x-twilio-signature': twilioSignature(TOKEN, 'ws://gateway.test/media'),
      },
    });
    await once(ws, 'open');

    const bytesBeforeMark: Record<string, number> = {};
    let bytes = 0;
    const marks: string[] = [];
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as {
        event: string;
        media?: { payload: string };
        mark?: { name: string };
      };
      if (message.event === 'media' && message.media) {
        bytes += Buffer.from(message.media.payload, 'base64').length;
      }
      if (message.event === 'mark' && message.mark) {
        bytesBeforeMark[message.mark.name] = bytes;
        bytes = 0;
        marks.push(message.mark.name);
        // Twilio echoes a mark once its audio has played.
        ws.send(JSON.stringify({ event: 'mark', mark: message.mark }));
      }
    });

    ws.send(JSON.stringify({ event: 'connected', protocol: 'Call' }));
    ws.send(
      JSON.stringify({
        event: 'start',
        start: {
          accountSid: ACCOUNT_SID,
          streamSid: 'MZ1',
          callSid: 'CA1',
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 },
          customParameters: { patientLanguageId: 'spanish' },
        },
      }),
    );

    const startedAt = Date.now();
    let offset = 0;
    const stream = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const speech = elapsed > 800 && elapsed < 1400; // after calibration
      ws.send(
        JSON.stringify({
          event: 'media',
          media: { track: 'inbound', payload: mulawFrame(speech, offset) },
        }),
      );
      offset += 160;
    }, 20);

    try {
      const deadline = Date.now() + 5000;
      while (!marks.includes('reply-1') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      clearInterval(stream);
      ws.close();
    }

    expect(marks.slice(0, 3)).toEqual(['beep', 'reply-1', 'beep']);
    // The reply holds the ~0.6 s spoken plus pre-roll and trailing silence.
    expect(bytesBeforeMark['reply-1']).toBeGreaterThan(4800);
  });
});

describe('describeTwiml', () => {
  it('turns TwiML into readable steps', () => {
    const steps = describeTwiml(
      '<?xml version="1.0"?><Response><Say voice="x">It&apos;s here</Say>' +
        '<Connect action="https://a/voice/ai-ended"><Stream url="wss://a/media">' +
        '<Parameter name="patientLanguageId" value="spanish"/></Stream></Connect><Hangup/></Response>',
    );
    expect(steps[0]).toBe('say     "It\'s here"');
    expect(steps[1]).toContain('connect');
    expect(steps[2]).toContain('wss://a/media');
    expect(steps[3]).toContain('patientLanguageId = spanish');
    expect(steps[4]).toContain('hangup');
  });
});

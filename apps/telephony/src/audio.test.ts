import { describe, expect, it } from 'vitest';

import {
  CUES,
  Downsampler2x,
  TELEPHONY_RATE_HZ,
  Upsampler2x,
  decodeMulaw,
  encodeMulaw,
  int16FromBytes,
} from './audio.js';

function sine(
  hz: number,
  rateHz: number,
  samples: number,
  amplitude = 0.5,
): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(
      amplitude * 32767 * Math.sin((2 * Math.PI * hz * i) / rateHz),
    );
  }
  return out;
}

/** Amplitude (0..1) of one frequency; window must hold whole cycles. */
function amplitudeAt(samples: Int16Array, hz: number, rateHz: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    const phase = (2 * Math.PI * hz * i) / rateHz;
    re += (samples[i] ?? 0) * Math.cos(phase);
    im += (samples[i] ?? 0) * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / samples.length / 32767;
}

function inChunks<T extends { process(x: Int16Array): Int16Array }>(
  resampler: T,
  input: Int16Array,
  sizes: number[],
): Int16Array {
  const parts: Int16Array[] = [];
  let at = 0;
  for (let i = 0; at < input.length; i++) {
    const size = sizes[i % sizes.length] ?? 1;
    parts.push(resampler.process(input.subarray(at, at + size)));
    at += size;
  }
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('μ-law', () => {
  it('round-trips every code through encode(decode(x))', () => {
    const codes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const pcm = decodeMulaw(codes);
    expect(Array.from(decodeMulaw(encodeMulaw(pcm)))).toEqual(Array.from(pcm));
  });

  it('matches G.711 reference points', () => {
    expect(
      Array.from(decodeMulaw(Uint8Array.of(0xff, 0x7f, 0x80, 0x00))),
    ).toEqual([0, 0, 32124, -32124]);
    expect(Array.from(encodeMulaw(Int16Array.of(0, 32767, -32768)))).toEqual([
      0xff, 0x80, 0x00,
    ]);
  });
});

describe('Downsampler2x (16 kHz → 8 kHz)', () => {
  it('passes speech-band audio at unity gain', () => {
    const out = new Downsampler2x().process(sine(1000, 16000, 16000));
    const settled = out.subarray(80, 80 + 7200);
    expect(amplitudeAt(settled, 1000, 8000)).toBeCloseTo(0.5, 1);
  });

  it('rejects content above 4 kHz by at least 40 dB (no aliasing)', () => {
    const out = new Downsampler2x().process(sine(6000, 16000, 16000));
    // 6 kHz would alias to 2 kHz at 8 kHz.
    const settled = out.subarray(80, 80 + 7200);
    expect(amplitudeAt(settled, 2000, 8000)).toBeLessThan(0.005);
  });

  it('streams identically regardless of chunk boundaries', () => {
    const input = sine(700, 16000, 4001);
    const whole = new Downsampler2x().process(input);
    const chunked = inChunks(new Downsampler2x(), input, [7, 160, 1, 33, 320]);
    expect(Array.from(chunked)).toEqual(Array.from(whole));
    expect(whole.length).toBe(2000);
  });
});

describe('Upsampler2x (8 kHz → 16 kHz)', () => {
  it('doubles the length and keeps speech-band amplitude', () => {
    const out = new Upsampler2x().process(sine(1000, 8000, 8000));
    expect(out.length).toBe(16000);
    const settled = out.subarray(160, 160 + 14400);
    expect(amplitudeAt(settled, 1000, 16000)).toBeCloseTo(0.5, 1);
  });

  it('suppresses the 7 kHz image by at least 40 dB', () => {
    const out = new Upsampler2x().process(sine(1000, 8000, 8000));
    const settled = out.subarray(160, 160 + 14400);
    expect(amplitudeAt(settled, 7000, 16000)).toBeLessThan(0.005);
  });

  it('streams identically regardless of chunk boundaries', () => {
    const input = sine(300, 8000, 2000);
    const whole = new Upsampler2x().process(input);
    const chunked = inChunks(new Upsampler2x(), input, [160, 3, 1, 77]);
    expect(Array.from(chunked)).toEqual(Array.from(whole));
  });
});

describe('helpers', () => {
  it('reads PCM16 bytes at an odd byte offset, including Buffer views from ws', () => {
    const backing = Buffer.alloc(5);
    backing.writeInt16LE(-1234, 1);
    backing.writeInt16LE(4321, 3);
    // Buffer#subarray (like the payload ws hands over) keeps the odd offset.
    expect(Array.from(int16FromBytes(backing.subarray(1)))).toEqual([
      -1234, 4321,
    ]);
    const plain = new Uint8Array(backing).subarray(1);
    expect(Array.from(int16FromBytes(plain))).toEqual([-1234, 4321]);
  });

  it('renders cues at telephony rate', () => {
    expect(CUES.clinician.length).toBe((TELEPHONY_RATE_HZ * 180) / 1000);
    expect(CUES.repeat.length).toBe((TELEPHONY_RATE_HZ * 320) / 1000);
  });
});

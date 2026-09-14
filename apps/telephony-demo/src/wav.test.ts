import { describe, expect, it } from 'vitest';

import { encodeWav, parseWav, toSpeechRate, trimSilence } from './wav.js';

function stereoWav(rateHz: number, frames: [number, number][]): Buffer {
  const data = Buffer.alloc(frames.length * 4);
  frames.forEach(([left, right], i) => {
    data.writeInt16LE(left, i * 4);
    data.writeInt16LE(right, i * 4 + 2);
  });
  const header = encodeWav(new Int16Array(0), rateHz);
  header.writeUInt16LE(2, 22); // channels
  header.writeUInt32LE(rateHz * 4, 28); // byte rate
  header.writeUInt16LE(4, 32); // block align
  header.writeUInt32LE(data.length, 40);
  header.writeUInt32LE(36 + data.length, 4);
  return Buffer.concat([header, data]);
}

describe('wav', () => {
  it('round-trips 16 kHz mono PCM', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    const pcm = parseWav(encodeWav(samples, 16000));
    expect(pcm.sampleRateHz).toBe(16000);
    expect(Array.from(pcm.samples)).toEqual(Array.from(samples));
  });

  it('downmixes stereo recordings', () => {
    const pcm = parseWav(
      stereoWav(48000, [
        [1000, 3000],
        [-2000, 0],
      ]),
    );
    expect(Array.from(pcm.samples)).toEqual([2000, -1000]);
  });

  it('resamples 48 kHz to 16 kHz without changing pitch', () => {
    const rate = 48000;
    const samples = Int16Array.from({ length: rate }, (_, i) =>
      Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / rate)),
    );
    const out = toSpeechRate({ sampleRateHz: rate, samples });
    expect(out.length).toBe(16000);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) {
      if ((out[i - 1] ?? 0) < 0 && (out[i] ?? 0) >= 0) {
        crossings++;
      }
    }
    expect(crossings).toBeGreaterThanOrEqual(438);
    expect(crossings).toBeLessThanOrEqual(442);
  });

  it('explains unsupported formats', () => {
    const wav = encodeWav(new Int16Array(4), 16000);
    wav.writeUInt16LE(24, 34); // 24-bit
    expect(() => parseWav(wav)).toThrowError(/16-bit PCM/);
    expect(() => parseWav(Buffer.from('not a wav file at all'))).toThrowError(
      /not a WAV/,
    );
  });

  it('trims silence around speech but keeps a margin', () => {
    const rate = 16000;
    const samples = new Int16Array(rate); // 1 s
    samples.fill(8000, 6000, 10000); // speech from 375 ms to 625 ms
    const trimmed = trimSilence(samples, rate);
    const margin = Math.round(rate * 0.08);
    expect(trimmed.length).toBe(4000 + 2 * margin - 1);
  });
});

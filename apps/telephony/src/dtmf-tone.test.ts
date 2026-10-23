import { describe, expect, it } from 'vitest';

import { decodeMulaw, encodeMulaw } from './audio.js';
import { DtmfToneDetector } from './dtmf-tone.js';

const RATE = 8000;
const ROWS = [697, 770, 852, 941];
const COLUMNS = [1209, 1336, 1477, 1633];
const KEYS = ['123A', '456B', '789C', '*0#D'];
const ALL_KEYS = KEYS.join('').split('');

/** Deterministic noise, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const samples = (ms: number) => Math.round((RATE * ms) / 1000);

function frequencies(key: string): [number, number] {
  const row = KEYS.findIndex((keys) => keys.includes(key));
  const column = KEYS[row]?.indexOf(key) ?? -1;
  return [ROWS[row] ?? 0, COLUMNS[column] ?? 0];
}

/** A keypad tone: amplitude per tone (fraction of full scale), optional twist. */
function tone(
  key: string,
  ms: number,
  options: { level?: number; twistDb?: number; phase?: number } = {},
): Float64Array {
  const [low, high] = frequencies(key);
  const level = options.level ?? 0.25;
  const highLevel = level * 10 ** ((options.twistDb ?? 0) / 20);
  const phase = options.phase ?? 0;
  return Float64Array.from({ length: samples(ms) }, (_, i) => {
    const t = i / RATE;
    return (
      level * Math.sin(2 * Math.PI * low * t + phase) +
      highLevel * Math.sin(2 * Math.PI * high * t + 2 * phase)
    );
  });
}

const silence = (ms: number) => new Float64Array(samples(ms));

function concat(...parts: Float64Array[]): Float64Array {
  const all = new Float64Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

/** As the gateway receives it: PCM16 → μ-law (phone network) → PCM16. */
function overTheWire(signal: Float64Array): Int16Array {
  const pcm = Int16Array.from(signal, (x) =>
    Math.max(-32768, Math.min(32767, Math.round(x * 32767))),
  );
  return decodeMulaw(encodeMulaw(pcm));
}

/** Feed in Twilio's 20 ms frames (or another chunk size); collect keys. */
function detect(signal: Float64Array, chunk = 160): string[] {
  const detector = new DtmfToneDetector();
  const pcm = overTheWire(signal);
  const keys: string[] = [];
  for (let i = 0; i < pcm.length; i += chunk) {
    keys.push(...detector.push(pcm.subarray(i, i + chunk)));
  }
  return keys;
}

function harmonics(
  f0: (t: number) => number,
  ms: number,
  amplitude: (hz: number) => number,
): Float64Array {
  const out = new Float64Array(samples(ms));
  const phases = new Float64Array(40);
  for (let i = 0; i < out.length; i++) {
    const fundamental = f0(i / RATE);
    let x = 0;
    for (let h = 1; h <= phases.length && h * fundamental < RATE / 2; h++) {
      phases[h - 1] =
        (phases[h - 1] ?? 0) + (2 * Math.PI * h * fundamental) / RATE;
      x += amplitude(h * fundamental) * Math.sin(phases[h - 1] ?? 0);
    }
    out[i] = x;
  }
  return out;
}

/** Speech-like spectrum: harmonics shaped by three vowel formants. */
const formants = (f1: number, f2: number, f3: number) => (hz: number) =>
  0.12 / (1 + ((hz - f1) / 90) ** 2) +
  0.08 / (1 + ((hz - f2) / 110) ** 2) +
  0.04 / (1 + ((hz - f3) / 150) ** 2);

describe('DtmfToneDetector', () => {
  it('detects every key, once, after a μ-law round trip', () => {
    for (const key of ALL_KEYS) {
      for (const ms of [45, 70, 120]) {
        expect(
          detect(concat(silence(30), tone(key, ms), silence(80))),
          `${key} ${ms} ms`,
        ).toEqual([key]);
      }
    }
  });

  it('tells # from * and from digits in a dialled string', () => {
    const keys = '#*#0#9*#';
    const signal = concat(
      ...keys.split('').flatMap((key) => [tone(key, 70), silence(60)]),
    );
    expect(detect(signal).join('')).toBe(keys);
  });

  it('works across realistic levels and twist', () => {
    for (const level of [0.5, 0.2, 0.05, 0.02]) {
      expect(
        detect(concat(tone('#', 80, { level }), silence(60))),
        `level ${level}`,
      ).toEqual(['#']);
    }
    for (const twistDb of [-6, -4, 4, 6]) {
      expect(
        detect(concat(tone('#', 80, { twistDb }), silence(60))),
        `twist ${twistDb}`,
      ).toEqual(['#']);
    }
  });

  it('rejects tones too unbalanced to be DTMF (twist > 8 dB)', () => {
    expect(detect(tone('#', 100, { twistDb: 12 }))).toEqual([]);
    expect(detect(tone('#', 100, { twistDb: -12 }))).toEqual([]);
  });

  it('counts presses separated by 60 ms gaps separately', () => {
    const signal = concat(
      tone('#', 70),
      silence(60),
      tone('#', 70, { phase: 1 }),
      silence(60),
      tone('#', 70, { phase: 2 }),
      silence(60),
    );
    expect(detect(signal)).toEqual(['#', '#', '#']);
  });

  it('counts one long press once', () => {
    expect(detect(concat(tone('#', 2_000), silence(100)))).toEqual(['#']);
  });

  it('is independent of chunk size and alignment', () => {
    const signal = concat(
      tone('#', 60),
      silence(60),
      tone('5', 60),
      silence(60),
    );
    for (const chunk of [1, 7, 80, 160, 333, 4000]) {
      expect(detect(signal, chunk), `chunk ${chunk}`).toEqual(['#', '5']);
    }
    for (let offset = 0; offset < 64; offset += 8) {
      expect(
        detect(concat(silence(offset / 8), tone('#', 42), silence(60))),
        `offset ${offset}`,
      ).toEqual(['#']);
    }
  });

  it('ignores tone bursts too short to be a keypress', () => {
    expect(detect(concat(tone('#', 20), silence(100)))).toEqual([]);
    expect(detect(concat(tone('1', 25), silence(100)))).toEqual([]);
  });

  it('still hears a key under moderate noise', () => {
    const next = random(7);
    const signal = concat(
      silence(50),
      tone('#', 80, { level: 0.2 }),
      silence(60),
    ).map((x) => x + 0.02 * (next() * 2 - 1));
    expect(detect(signal)).toEqual(['#']);
  });

  it('stays quiet on silence', () => {
    expect(detect(silence(3_000))).toEqual([]);
  });

  it('stays quiet on white noise at any level', () => {
    for (const level of [0.01, 0.1, 0.5]) {
      const next = random(level * 1000);
      const noise = Float64Array.from(
        { length: samples(5_000) },
        () => level * (next() * 2 - 1),
      );
      expect(detect(noise), `noise ${level}`).toEqual([]);
    }
  });

  it('stays quiet on speech-like harmonic signals', () => {
    const vowels = [
      formants(700, 1220, 2600), // "a", formants near DTMF tones
      formants(300, 2300, 3000), // "i"
      formants(500, 900, 2400), // "o"
    ];
    for (const shape of vowels) {
      for (const f0 of [95, 120, 180, 232.33, 250]) {
        // Gentle vibrato, as a voice has.
        const voice = harmonics(
          (t) => f0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t)),
          1_500,
          shape,
        );
        expect(detect(voice), `f0 ${f0}`).toEqual([]);
        const steady = harmonics(() => f0, 1_500, shape);
        expect(detect(steady), `steady f0 ${f0}`).toEqual([]);
      }
    }
  });

  it('stays quiet on chirps and gliding voices', () => {
    const glide = harmonics(
      (t) => 100 + 150 * t,
      1_000,
      formants(700, 1300, 2500),
    );
    expect(detect(glide)).toEqual([]);
    // Whistle-like sweeps across the whole band, alone and in pairs, at
    // speech-like rates of change (formant transitions move ≥ 1 kHz/s).
    for (const rate of [1_000, 3_000]) {
      let lowPhase = 0;
      let highPhase = 0;
      const sweeps = Float64Array.from({ length: samples(1_000) }, (_, i) => {
        const t = i / RATE;
        lowPhase += (2 * Math.PI * (300 + rate * t * 0.4)) / RATE;
        highPhase += (2 * Math.PI * (1000 + rate * t)) / RATE;
        return 0.25 * Math.sin(lowPhase) + 0.25 * Math.sin(highPhase);
      });
      expect(detect(sweeps), `sweep ${rate} Hz/s`).toEqual([]);
      let phase = 0;
      const single = Float64Array.from({ length: samples(1_000) }, (_, i) => {
        phase += (2 * Math.PI * (300 + rate * (i / RATE))) / RATE;
        return 0.4 * Math.sin(phase);
      });
      expect(detect(single), `single sweep ${rate} Hz/s`).toEqual([]);
    }
  });

  it('accepts keys slightly off frequency (±1 %)', () => {
    for (const key of ALL_KEYS) {
      for (const shift of [0.99, 1.01]) {
        const [low, high] = frequencies(key);
        const off = Float64Array.from({ length: samples(80) }, (_, i) => {
          const t = i / RATE;
          return (
            0.25 * Math.sin(2 * Math.PI * low * shift * t) +
            0.25 * Math.sin(2 * Math.PI * high * shift * t)
          );
        });
        expect(detect(concat(off, silence(60))), `${key} ×${shift}`).toEqual([
          key,
        ]);
      }
    }
  });

  it('stays quiet on call-progress tones and single DTMF frequencies', () => {
    const pair = (a: number, b: number, ms: number) =>
      Float64Array.from({ length: samples(ms) }, (_, i) => {
        const t = i / RATE;
        return (
          0.2 * Math.sin(2 * Math.PI * a * t) +
          0.2 * Math.sin(2 * Math.PI * b * t)
        );
      });
    expect(detect(pair(350, 440, 1_000))).toEqual([]); // dial tone
    expect(detect(pair(440, 480, 1_000))).toEqual([]); // ringback
    expect(detect(pair(480, 620, 1_000))).toEqual([]); // busy
    expect(detect(pair(697, 697, 1_000))).toEqual([]); // one row tone only
    expect(detect(pair(1477, 1477, 1_000))).toEqual([]); // one column tone only
    expect(detect(pair(697, 770, 1_000))).toEqual([]); // two rows, no column
  });

  it('supports other sample rates', () => {
    const detector = new DtmfToneDetector(16000);
    const [low, high] = frequencies('#');
    const pcm = Int16Array.from({ length: 16000 * 0.08 }, (_, i) =>
      Math.round(
        8000 *
          (Math.sin((2 * Math.PI * low * i) / 16000) +
            Math.sin((2 * Math.PI * high * i) / 16000)),
      ),
    );
    expect([
      ...detector.push(pcm),
      ...detector.push(new Int16Array(1600)),
    ]).toEqual(['#']);
  });
});

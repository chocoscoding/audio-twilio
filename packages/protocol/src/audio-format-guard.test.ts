import { describe, expect, it } from 'vitest';

import { SUPPORTED_SAMPLE_RATES_HZ, isWireAudioFormat } from './guards.js';

/**
 * `parseClientMessage` validates only the message TYPE. Everything else in a
 * control message is attacker-controlled until something checks it, and
 * `turn.start.audioFormat` is not inert data: `sampleRateHz` sizes the audio
 * chunk buffer and drives turn duration arithmetic.
 *
 * The case that motivated this guard: a declared rate of 0 makes the chunk
 * size 0, and a zero-length buffer never advances the aggregator's read
 * offset — the push loop spins forever emitting empty chunks into a growing
 * array. One control message plus one audio frame pins an ECS task's event
 * loop and exhausts its heap, killing every session that task serves.
 */

const VALID = { encoding: 'pcm_s16le', sampleRateHz: 16_000, channels: 1 };

describe('the accepted shape', () => {
  it('accepts the FourPoints wire contract', () => {
    expect(isWireAudioFormat(VALID)).toBe(true);
  });

  it('accepts every advertised supported rate', () => {
    for (const sampleRateHz of SUPPORTED_SAMPLE_RATES_HZ) {
      expect(isWireAudioFormat({ ...VALID, sampleRateHz })).toBe(true);
    }
  });

  it('advertises a non-empty allowlist', () => {
    // An empty list would make every format invalid and the guard vacuous.
    expect(SUPPORTED_SAMPLE_RATES_HZ.length).toBeGreaterThan(0);
  });

  /**
   * The allowlist is what makes the integer check redundant. Pinning its
   * SHAPE is what keeps the redundancy safe: if the list is ever widened to
   * include a fractional, zero, negative or absurd value — the edit that
   * would reintroduce the denial of service — this fails, rather than the
   * guard silently depending on a check nothing exercises.
   */
  it('contains only realistic positive integers', () => {
    for (const rate of SUPPORTED_SAMPLE_RATES_HZ) {
      expect(Number.isInteger(rate), `${rate} is not an integer`).toBe(true);
      expect(rate).toBeGreaterThan(0);
      // Guards against an entry large enough to make the chunk buffer an
      // allocation attack in its own right.
      expect(rate).toBeLessThanOrEqual(48_000);
    }
  });
});

describe('sample rate — the denial-of-service vector', () => {
  it.each([0, -1, -16_000])(
    'rejects %s, which yields a zero/negative buffer',
    (sampleRateHz) => {
      expect(isWireAudioFormat({ ...VALID, sampleRateHz })).toBe(false);
    },
  );

  it.each([
    8_000,
    44_100,
    48_000,
    1,
    1_000_000,
    2 ** 31,
    Number.MAX_SAFE_INTEGER,
  ])('rejects unsupported rate %s', (sampleRateHz) => {
    // Including plausible-but-unsupported rates: an allowlist, not a range.
    expect(isWireAudioFormat({ ...VALID, sampleRateHz })).toBe(false);
  });

  it.each([16_000.5, Number.NaN, Number.POSITIVE_INFINITY, -Number.NaN])(
    'rejects non-integer rate %s',
    (sampleRateHz) => {
      expect(isWireAudioFormat({ ...VALID, sampleRateHz })).toBe(false);
    },
  );

  it.each([['16000'], [null], [undefined], [{}], [[]], [true]])(
    'rejects non-numeric rate %s',
    (sampleRateHz) => {
      expect(isWireAudioFormat({ ...VALID, sampleRateHz })).toBe(false);
    },
  );
});

describe('encoding and channels', () => {
  it.each(['pcm16', 'PCM_S16LE', 'mulaw', 'opus', '', null, undefined, 1])(
    'rejects encoding %s',
    (encoding) => {
      expect(isWireAudioFormat({ ...VALID, encoding })).toBe(false);
    },
  );

  it.each([0, 2, 8, -1, '1', null, undefined])(
    'rejects channels %s',
    (channels) => {
      expect(isWireAudioFormat({ ...VALID, channels })).toBe(false);
    },
  );
});

describe('the container itself', () => {
  it.each([null, undefined, 'x', 42, true, []])(
    'rejects non-object %s',
    (value) => {
      expect(isWireAudioFormat(value)).toBe(false);
    },
  );

  it('rejects an object missing every field', () => {
    expect(isWireAudioFormat({})).toBe(false);
  });

  it('ignores extra fields rather than trusting them', () => {
    expect(isWireAudioFormat({ ...VALID, bitrate: 999, __proto__: {} })).toBe(
      true,
    );
  });
});

import { describe, expect, it } from 'vitest';

import { KeySequence } from './key-sequence.js';

function clocked(
  options: { count?: number; windowMs?: number; key?: string } = {},
) {
  let time = 0;
  const sequence = new KeySequence({ ...options, now: () => time });
  return {
    sequence,
    at(ms: number, digit: string) {
      time = ms;
      return sequence.press(digit);
    },
  };
}

describe('KeySequence', () => {
  it('fires on the third # in a row, then starts over', () => {
    const { at } = clocked();
    expect(at(0, '#')).toBe(false);
    expect(at(300, '#')).toBe(false);
    expect(at(600, '#')).toBe(true);
    expect(at(900, '#')).toBe(false);
    expect(at(1200, '#')).toBe(false);
    expect(at(1500, '#')).toBe(true);
  });

  it('any other key in between resets the run', () => {
    const { at } = clocked();
    expect(at(0, '#')).toBe(false);
    expect(at(100, '#')).toBe(false);
    expect(at(200, '1')).toBe(false);
    expect(at(300, '#')).toBe(false);
    expect(at(400, '*')).toBe(false);
    expect(at(500, '#')).toBe(false);
    expect(at(600, '#')).toBe(false);
    expect(at(700, '#')).toBe(true);
  });

  it('needs the first and last press within the window', () => {
    const { at } = clocked();
    expect(at(0, '#')).toBe(false);
    expect(at(3_000, '#')).toBe(false);
    expect(at(5_001, '#')).toBe(false); // 0 → 5001 is too far apart
    expect(at(6_000, '#')).toBe(true); // 3000, 5001, 6000 fit
  });

  it('accepts presses exactly windowMs apart', () => {
    const { at } = clocked();
    at(0, '#');
    at(2_500, '#');
    expect(at(5_000, '#')).toBe(true);
  });

  it('reset() forgets earlier presses', () => {
    const { sequence, at } = clocked();
    at(0, '#');
    at(100, '#');
    sequence.reset();
    expect(at(200, '#')).toBe(false);
    expect(at(300, '#')).toBe(false);
    expect(at(400, '#')).toBe(true);
  });

  it('honours a custom key, count and window', () => {
    const { at } = clocked({ key: '*', count: 2, windowMs: 1_000 });
    expect(at(0, '#')).toBe(false);
    expect(at(100, '*')).toBe(false);
    expect(at(1_200, '*')).toBe(false);
    expect(at(1_900, '*')).toBe(true);
  });

  it('uses the real clock by default', () => {
    const sequence = new KeySequence();
    expect(sequence.press('#')).toBe(false);
    expect(sequence.press('#')).toBe(false);
    expect(sequence.press('#')).toBe(true);
  });
});

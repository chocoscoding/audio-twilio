/**
 * Telephony audio primitives: G.711 μ-law codec, 2× half-band resamplers and
 * short cue tones.
 *
 * Every operation is a table lookup or a fixed-size filter per sample, with
 * no per-sample allocation, so the CPU cost of a call is constant and small:
 * a gateway instance scales with its cores, not with garbage collection.
 */

import { endianness } from 'node:os';

// Int16Array views over wire bytes assume a little-endian host (x86-64 and
// arm64 both are). Fail at startup rather than play noise.
if (endianness() !== 'LE') {
  throw new Error('@fourpoints/telephony requires a little-endian host');
}

/** Twilio Media Streams audio: 8 kHz mono μ-law, both directions. */
export const TELEPHONY_RATE_HZ = 8000;

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

const MULAW_DECODE = new Int16Array(256);
for (let byte = 0; byte < 256; byte++) {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const magnitude = (((u & 0x0f) << 3) + MULAW_BIAS) << exponent;
  MULAW_DECODE[byte] =
    u & 0x80 ? MULAW_BIAS - magnitude : magnitude - MULAW_BIAS;
}

/** Indexed by the sample's uint16 bit pattern. */
const MULAW_ENCODE = new Uint8Array(65536);
for (let index = 0; index < 65536; index++) {
  let sample = index >= 32768 ? index - 65536 : index;
  const sign = sample < 0 ? 0x80 : 0;
  sample = Math.min(Math.abs(sample), MULAW_CLIP) + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  MULAW_ENCODE[index] = ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function decodeMulaw(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    samples[i] = MULAW_DECODE[bytes[i] ?? 0xff] ?? 0;
  }
  return samples;
}

export function encodeMulaw(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    bytes[i] = MULAW_ENCODE[(samples[i] ?? 0) & 0xffff] ?? 0xff;
  }
  return bytes;
}

/** View little-endian PCM16 bytes as samples (copies only if misaligned). */
export function int16FromBytes(bytes: Uint8Array): Int16Array {
  // `new Uint8Array(x)` always copies; Buffer#slice would return a view and
  // keep the odd offset.
  const aligned = bytes.byteOffset % 2 === 0 ? bytes : new Uint8Array(bytes);
  return new Int16Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength >> 1,
  );
}

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

/**
 * Half-band low-pass (cut-off at a quarter of the higher sample rate) shared
 * by both resamplers. A half-band filter's even taps are zero, so only the
 * centre tap (0.5) and the odd side taps below are ever multiplied.
 * 47 taps, Blackman window: ≥40 dB rejection by 6 kHz at 16 kHz.
 */
const HALF_BAND_ORDER = 23;

const SIDE_TAPS: Float64Array = (() => {
  const taps = new Float64Array((HALF_BAND_ORDER + 1) / 2);
  let sum = 0;
  for (let t = 0; t < taps.length; t++) {
    const k = 2 * t + 1;
    const x = k / (HALF_BAND_ORDER + 1);
    const window =
      0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
    const tap = (Math.sin((Math.PI * k) / 2) / (Math.PI * k)) * window;
    taps[t] = tap;
    sum += tap;
  }
  // Unity DC gain: centre 0.5 + both sides 2·Σ = 1.
  for (let t = 0; t < taps.length; t++) {
    taps[t] = ((taps[t] ?? 0) * 0.25) / sum;
  }
  return taps;
})();

/** 16 kHz → 8 kHz, streaming: filter state carries across chunks. */
export class Downsampler2x {
  private readonly history = new Float64Array(2 * HALF_BAND_ORDER + 1);
  private position = 0;
  private odd = false;

  reset(): void {
    this.history.fill(0);
    this.position = 0;
    this.odd = false;
  }

  process(input: Int16Array): Int16Array {
    const size = this.history.length;
    const output = new Int16Array((input.length + (this.odd ? 1 : 0)) >> 1);
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      this.history[this.position] = input[i] ?? 0;
      this.position = (this.position + 1) % size;
      this.odd = !this.odd;
      if (this.odd) {
        continue; // keep every second sample
      }
      // `position` is now the oldest sample; the centre is ORDER later.
      const centre = this.position + HALF_BAND_ORDER;
      let acc = 0.5 * (this.history[centre % size] ?? 0);
      for (let t = 0; t < SIDE_TAPS.length; t++) {
        const k = 2 * t + 1;
        acc +=
          (SIDE_TAPS[t] ?? 0) *
          ((this.history[(centre - k) % size] ?? 0) +
            (this.history[(centre + k) % size] ?? 0));
      }
      output[written++] = clamp16(acc);
    }
    return output;
  }
}

/** 8 kHz → 16 kHz, streaming polyphase interpolation. */
export class Upsampler2x {
  private readonly history = new Float64Array(HALF_BAND_ORDER + 1);
  private position = 0;

  reset(): void {
    this.history.fill(0);
    this.position = 0;
  }

  process(input: Int16Array): Int16Array {
    const size = this.history.length;
    const lag = (HALF_BAND_ORDER - 1) / 2; // older neighbours of the centre
    const output = new Int16Array(input.length * 2);
    for (let i = 0; i < input.length; i++) {
      this.history[this.position] = input[i] ?? 0;
      this.position = (this.position + 1) % size;
      const centre = this.position + lag;
      let between = 0;
      for (let t = 0; t < SIDE_TAPS.length; t++) {
        between +=
          (SIDE_TAPS[t] ?? 0) *
          ((this.history[(centre - t) % size] ?? 0) +
            (this.history[(centre + t + 1) % size] ?? 0));
      }
      output[2 * i] = clamp16(this.history[centre % size] ?? 0);
      output[2 * i + 1] = clamp16(2 * between);
    }
    return output;
  }
}

/** A sequence of tone segments (hz 0 = silence), rendered to μ-law. */
function renderTone(
  segments: readonly { hz: number; ms: number }[],
): Uint8Array {
  const fadeSamples = Math.round(TELEPHONY_RATE_HZ * 0.008);
  const parts: Int16Array[] = segments.map(({ hz, ms }) => {
    const length = Math.round((TELEPHONY_RATE_HZ * ms) / 1000);
    const pcm = new Int16Array(length);
    for (let i = 0; hz > 0 && i < length; i++) {
      const edge = Math.min(i, length - 1 - i);
      const fade =
        edge < fadeSamples
          ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / fadeSamples)
          : 1;
      pcm[i] = Math.round(
        0.2 *
          32767 *
          fade *
          Math.sin((2 * Math.PI * hz * i) / TELEPHONY_RATE_HZ),
      );
    }
    return pcm;
  });
  const all = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return encodeMulaw(all);
}

/**
 * Audible floor cues. A phone has no screen, so pitch tells the room whose
 * turn it is: low = clinician, high = patient, double beep = please repeat.
 */
export const CUES = {
  clinician: renderTone([{ hz: 440, ms: 180 }]),
  patient: renderTone([{ hz: 660, ms: 180 }]),
  repeat: renderTone([
    { hz: 350, ms: 120 },
    { hz: 0, ms: 80 },
    { hz: 350, ms: 120 },
  ]),
} as const;

export type Cue = keyof typeof CUES;

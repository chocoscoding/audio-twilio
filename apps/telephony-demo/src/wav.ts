/**
 * Just enough WAV handling for demo recordings: read 16-bit PCM (any rate,
 * mono or stereo), convert to the 16 kHz mono PCM FourPoints speech uses,
 * trim silence, and write WAV for inspection.
 */

export interface Pcm {
  sampleRateHz: number;
  samples: Int16Array;
}

export const SPEECH_RATE_HZ = 16000;

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function parseWav(buf: Buffer): Pcm {
  if (
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a WAV file');
  }
  let channels = 0;
  let sampleRateHz = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body);
      const bits = buf.readUInt16LE(body + 14);
      const pcm =
        format === WAVE_FORMAT_PCM ||
        (format === WAVE_FORMAT_EXTENSIBLE &&
          buf.readUInt16LE(body + 24) === WAVE_FORMAT_PCM);
      if (!pcm || bits !== 16) {
        throw new Error(
          'expected 16-bit PCM (export as "WAV, signed 16-bit PCM")',
        );
      }
      channels = buf.readUInt16LE(body + 2);
      sampleRateHz = buf.readUInt32LE(body + 4);
    } else if (id === 'data') {
      if (channels === 0) {
        throw new Error('data chunk before fmt chunk');
      }
      const frames = Math.floor(
        Math.min(size, buf.length - body) / (2 * channels),
      );
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          sum += buf.readInt16LE(body + (i * channels + c) * 2);
        }
        samples[i] = Math.round(sum / channels);
      }
      return { sampleRateHz, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('no audio data');
}

/** Resample to 16 kHz: box low-pass when reducing the rate, then linear interpolation. */
export function toSpeechRate(pcm: Pcm): Int16Array {
  const { sampleRateHz, samples } = pcm;
  if (sampleRateHz === SPEECH_RATE_HZ) {
    return samples;
  }
  const ratio = sampleRateHz / SPEECH_RATE_HZ;
  const width = Math.max(1, Math.round(ratio));
  const source = new Float64Array(samples.length);
  let running = 0;
  for (let i = 0; i < samples.length; i++) {
    running += samples[i] ?? 0;
    if (i >= width) {
      running -= samples[i - width] ?? 0;
    }
    source[i] = running / Math.min(i + 1, width);
  }
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = source[index] ?? 0;
    const b = source[index + 1] ?? a;
    out[i] = Math.round(a + (b - a) * fraction);
  }
  return out;
}

/** Drop leading/trailing silence, keeping a short margin so words are not clipped. */
export function trimSilence(
  samples: Int16Array,
  sampleRateHz: number,
): Int16Array {
  const threshold = 0.02 * 32767;
  const margin = Math.round(sampleRateHz * 0.08);
  let start = 0;
  while (start < samples.length && Math.abs(samples[start] ?? 0) < threshold) {
    start++;
  }
  let end = samples.length - 1;
  while (end > start && Math.abs(samples[end] ?? 0) < threshold) {
    end--;
  }
  if (start >= end) {
    return samples;
  }
  return samples.subarray(
    Math.max(0, start - margin),
    Math.min(samples.length, end + margin),
  );
}

export function encodeWav(samples: Int16Array, sampleRateHz: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([
    header,
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
  ]);
}

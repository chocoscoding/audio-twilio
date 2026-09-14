import { describe, expect, it } from 'vitest';

import {
  AUDIO_FRAME_HEADER_BYTES,
  decodeAudioFrame,
  decodeTtsAudioFrame,
  encodeAudioFrame,
  encodeTtsAudioFrame,
} from './audio-frame.js';

describe('synthesized speech frame codec', () => {
  it('round-trips a TTS frame with its payload intact', () => {
    const payload = new Uint8Array([1, 0, 255, 127, 0, 128]);
    const encoded = encodeTtsAudioFrame({
      sequence: 7,
      timestampMs: 1756100000999.5,
      payload,
    });

    expect(encoded.byteLength).toBe(
      AUDIO_FRAME_HEADER_BYTES + payload.byteLength,
    );
    const decoded = decodeTtsAudioFrame(encoded);
    expect(decoded?.sequence).toBe(7);
    expect(decoded?.timestampMs).toBe(1756100000999.5);
    expect(Array.from(decoded?.payload ?? [])).toEqual(Array.from(payload));
  });

  it('keeps capture and synthesis frames distinguishable', () => {
    const capture = encodeAudioFrame({
      sequence: 0,
      captureTimestampMs: 1,
      samples: new Int16Array([5]),
    });
    const tts = encodeTtsAudioFrame({
      sequence: 0,
      timestampMs: 1,
      payload: new Uint8Array([5, 0]),
    });

    // Each decoder rejects the other's frame type rather than guessing.
    expect(decodeTtsAudioFrame(capture)).toBeNull();
    expect(decodeAudioFrame(tts)).toBeNull();
  });

  it('rejects a malformed TTS frame', () => {
    expect(decodeTtsAudioFrame(new Uint8Array(4))).toBeNull();
    const odd = encodeTtsAudioFrame({
      sequence: 0,
      timestampMs: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(decodeTtsAudioFrame(odd)).toBeNull();
  });
});

describe('binary audio frame codec', () => {
  it('round-trips a PCM16 frame', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 12345]);
    const encoded = encodeAudioFrame({
      sequence: 42,
      captureTimestampMs: 1756100000123.5,
      samples,
    });

    expect(encoded.byteLength).toBe(
      AUDIO_FRAME_HEADER_BYTES + samples.length * 2,
    );

    const decoded = decodeAudioFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.sequence).toBe(42);
    expect(decoded?.captureTimestampMs).toBe(1756100000123.5);
    expect(Array.from(decoded?.samples ?? [])).toEqual(Array.from(samples));
  });

  it('round-trips an empty payload (header-only frame)', () => {
    const encoded = encodeAudioFrame({
      sequence: 0,
      captureTimestampMs: 0,
      samples: new Int16Array(0),
    });
    const decoded = decodeAudioFrame(encoded);
    expect(decoded?.samples.length).toBe(0);
  });

  it('decodes from a Uint8Array view at a non-zero byte offset', () => {
    const samples = new Int16Array([7, -7]);
    const encoded = new Uint8Array(
      encodeAudioFrame({ sequence: 3, captureTimestampMs: 9, samples }),
    );
    const padded = new Uint8Array(encoded.length + 8);
    padded.set(encoded, 8);
    const view = padded.subarray(8);

    const decoded = decodeAudioFrame(view);
    expect(decoded?.sequence).toBe(3);
    expect(Array.from(decoded?.samples ?? [])).toEqual([7, -7]);
  });

  it('rejects frames shorter than the header', () => {
    expect(decodeAudioFrame(new Uint8Array(15))).toBeNull();
  });

  it('rejects unknown frame types and versions', () => {
    const encoded = new Uint8Array(
      encodeAudioFrame({
        sequence: 0,
        captureTimestampMs: 0,
        samples: new Int16Array([1]),
      }),
    );
    const badType = encoded.slice();
    badType[0] = 0x7f;
    expect(decodeAudioFrame(badType)).toBeNull();

    const badVersion = encoded.slice();
    badVersion[1] = 99;
    expect(decodeAudioFrame(badVersion)).toBeNull();
  });

  it('rejects odd payload lengths', () => {
    const encoded = new Uint8Array(
      encodeAudioFrame({
        sequence: 0,
        captureTimestampMs: 0,
        samples: new Int16Array([1]),
      }),
    );
    expect(
      decodeAudioFrame(encoded.subarray(0, encoded.length - 1)),
    ).toBeNull();
  });
});

/**
 * Binary WebSocket audio frame layout, version 1 (decision SLICE1-001).
 *
 * Audio travels as binary WebSocket frames (demo-build-spec.md §21). Each
 * frame is one contiguous chunk of PCM audio with a fixed 16-byte header.
 * All multi-byte fields are little-endian.
 *
 * ```text
 * offset  size  field
 * 0       u8    frame type        (0x01 = PCM16 audio)
 * 1       u8    layout version    (1)
 * 2       u16   reserved          (0)
 * 4       u32   sequence number   (starts at 0, resets each turn)
 * 8       f64   capture timestamp (client clock, epoch milliseconds)
 * 16      ...   payload           (PCM signed 16-bit little-endian mono)
 * ```
 *
 * Payload length is variable; the sample count is derived from the byte
 * length. The sample rate is NOT in the frame: it is declared once per turn
 * in the `turn.start` control message (`audioFormat`).
 */

export const AUDIO_FRAME_TYPE_PCM16 = 0x01;
/**
 * Server → client synthesized speech (Slice 4). Same 16-byte header layout;
 * the payload is provider PCM relayed verbatim, so it is carried as raw
 * bytes rather than decoded samples. The playback format is declared once
 * per utterance in `tts.started` (audioFormat), mirroring how capture
 * format is declared in `turn.start`.
 */
export const AUDIO_FRAME_TYPE_TTS_PCM16 = 0x02;
export const AUDIO_FRAME_LAYOUT_VERSION = 1;
export const AUDIO_FRAME_HEADER_BYTES = 16;

export interface AudioFrame {
  /** Per-turn frame counter starting at 0. */
  sequence: number;
  /** Client capture clock, epoch milliseconds. */
  captureTimestampMs: number;
  /** PCM signed 16-bit mono samples. */
  samples: Int16Array;
}

export function encodeAudioFrame(frame: AudioFrame): ArrayBuffer {
  const buffer = new ArrayBuffer(
    AUDIO_FRAME_HEADER_BYTES + frame.samples.length * 2,
  );
  const view = new DataView(buffer);
  view.setUint8(0, AUDIO_FRAME_TYPE_PCM16);
  view.setUint8(1, AUDIO_FRAME_LAYOUT_VERSION);
  view.setUint16(2, 0, true);
  view.setUint32(4, frame.sequence, true);
  view.setFloat64(8, frame.captureTimestampMs, true);
  for (let i = 0; i < frame.samples.length; i++) {
    view.setInt16(
      AUDIO_FRAME_HEADER_BYTES + i * 2,
      frame.samples[i] ?? 0,
      true,
    );
  }
  return buffer;
}

/** A chunk of synthesized speech travelling server → client. */
export interface TtsAudioFrame {
  /** Per-utterance chunk counter starting at 0. */
  sequence: number;
  /** Server relay clock, epoch milliseconds. */
  timestampMs: number;
  /** Provider PCM bytes, relayed verbatim (s16le mono at the declared rate). */
  payload: Uint8Array;
}

export function encodeTtsAudioFrame(frame: TtsAudioFrame): ArrayBuffer {
  const buffer = new ArrayBuffer(
    AUDIO_FRAME_HEADER_BYTES + frame.payload.byteLength,
  );
  const view = new DataView(buffer);
  view.setUint8(0, AUDIO_FRAME_TYPE_TTS_PCM16);
  view.setUint8(1, AUDIO_FRAME_LAYOUT_VERSION);
  view.setUint16(2, 0, true);
  view.setUint32(4, frame.sequence, true);
  view.setFloat64(8, frame.timestampMs, true);
  new Uint8Array(buffer, AUDIO_FRAME_HEADER_BYTES).set(frame.payload);
  return buffer;
}

/** Decode a synthesized-speech frame, or null when malformed. */
export function decodeTtsAudioFrame(
  data: ArrayBuffer | Uint8Array,
): TtsAudioFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== AUDIO_FRAME_TYPE_TTS_PCM16) {
    return null;
  }
  if (view.getUint8(1) !== AUDIO_FRAME_LAYOUT_VERSION) {
    return null;
  }
  const payloadBytes = bytes.byteLength - AUDIO_FRAME_HEADER_BYTES;
  if (payloadBytes % 2 !== 0) {
    return null;
  }
  return {
    sequence: view.getUint32(4, true),
    timestampMs: view.getFloat64(8, true),
    payload: bytes.slice(AUDIO_FRAME_HEADER_BYTES),
  };
}

/**
 * Decode a binary frame, or return null when the frame is malformed
 * (too short, unknown type/version, or odd payload length). Malformed
 * frames must be dropped explicitly, never guessed at.
 */
export function decodeAudioFrame(
  data: ArrayBuffer | Uint8Array,
): AudioFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== AUDIO_FRAME_TYPE_PCM16) {
    return null;
  }
  if (view.getUint8(1) !== AUDIO_FRAME_LAYOUT_VERSION) {
    return null;
  }
  const payloadBytes = bytes.byteLength - AUDIO_FRAME_HEADER_BYTES;
  if (payloadBytes % 2 !== 0) {
    return null;
  }
  const samples = new Int16Array(payloadBytes / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(AUDIO_FRAME_HEADER_BYTES + i * 2, true);
  }
  return {
    sequence: view.getUint32(4, true),
    captureTimestampMs: view.getFloat64(8, true),
    samples,
  };
}

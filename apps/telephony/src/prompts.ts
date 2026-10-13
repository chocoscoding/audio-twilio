/**
 * Recorded IVR prompts (ivr-audio/final, made by ivr-audio/pipeline.mjs).
 *
 * A live <Say> is synthesized by Twilio on every call, which is the pause
 * callers hear after each keypress. Recorded clips are served to Twilio for
 * <Play> (cached by URL) and played straight into media streams.
 *
 * A clip is used only when it says exactly what the code would say (see
 * `match`), so a changed line or a re-ordered language menu falls back to
 * <Say> instead of playing outdated audio.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PromptClip {
  id: string;
  /** What the clip says (its manifest text). */
  text: string;
  /** The whole WAV file, as served to Twilio. */
  wav: Buffer;
  /** 8 kHz mono μ-law samples, for media streams. */
  mulaw: Uint8Array;
  /** Content hash, carried in the URL so Twilio's cache never plays an old take. */
  version: string;
}

const MULAW_FORMAT = 7;
const ID = /^[a-z0-9-]{1,64}$/;

/** The μ-law samples of an 8 kHz mono G.711 μ-law WAV; throws otherwise. */
export function parseMulawWav(wav: Buffer): Uint8Array {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a WAV file');
  }
  let format = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunk = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunk === 'fmt ') {
      format =
        wav.readUInt16LE(body) === MULAW_FORMAT &&
        wav.readUInt16LE(body + 2) === 1 &&
        wav.readUInt32LE(body + 4) === 8000;
      if (!format) {
        throw new Error('not 8 kHz mono μ-law');
      }
    } else if (chunk === 'data') {
      if (!format || body + size > wav.length) {
        throw new Error('bad data chunk');
      }
      return new Uint8Array(wav.buffer, wav.byteOffset + body, size);
    }
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** An 8 kHz mono μ-law WAV around `mulaw` (tests and tools). */
export function mulawWav(mulaw: Uint8Array): Buffer {
  const header = Buffer.alloc(46);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(38 + mulaw.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(18, 16);
  header.writeUInt16LE(MULAW_FORMAT, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 38, 'ascii');
  header.writeUInt32LE(mulaw.length, 42);
  return Buffer.concat([header, mulaw]);
}

function clipOf(id: string, text: string, wav: Buffer): PromptClip {
  return {
    id,
    text,
    wav,
    mulaw: parseMulawWav(wav),
    version: createHash('sha256').update(wav).digest('hex').slice(0, 12),
  };
}

export class PromptLibrary {
  private constructor(private readonly clips: Map<string, PromptClip>) {}

  static readonly empty = new PromptLibrary(new Map());

  /**
   * Load ivr-audio/final: manifest.json + one WAV per clip. A clip that is
   * missing or not phone format is skipped (it falls back to <Say>); a
   * missing manifest throws.
   */
  static load(
    dir: string,
    onSkip: (id: string, reason: string) => void = () => undefined,
  ): PromptLibrary {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    ) as { clips?: Record<string, { file?: unknown; text?: unknown }> };
    const clips = new Map<string, PromptClip>();
    for (const [id, entry] of Object.entries(manifest.clips ?? {})) {
      if (
        !ID.test(id) ||
        typeof entry.text !== 'string' ||
        entry.file !== `${id}.wav`
      ) {
        onSkip(id, 'bad manifest entry');
        continue;
      }
      try {
        clips.set(
          id,
          clipOf(id, entry.text, readFileSync(join(dir, entry.file))),
        );
      } catch (error) {
        onSkip(id, error instanceof Error ? error.message : 'unreadable');
      }
    }
    return new PromptLibrary(clips);
  }

  /** In-memory library (tests). */
  static of(
    clips: ReadonlyArray<{ id: string; text: string; mulaw: Uint8Array }>,
  ): PromptLibrary {
    return new PromptLibrary(
      new Map(
        clips.map((c) => [c.id, clipOf(c.id, c.text, mulawWav(c.mulaw))]),
      ),
    );
  }

  get size(): number {
    return this.clips.size;
  }

  clip(id: string): PromptClip | undefined {
    return this.clips.get(id);
  }

  /**
   * The clip `id` when it says `text` — exactly, or `text` followed by more
   * (an AI greeting followed by the same in the caller's language).
   * Otherwise undefined, and the caller falls back to <Say>.
   */
  match(id: string, text: string): PromptClip | undefined {
    const clip = this.clips.get(id);
    return clip !== undefined &&
      (clip.text === text || clip.text.startsWith(`${text} `))
      ? clip
      : undefined;
  }
}

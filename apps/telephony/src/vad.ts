/**
 * Local energy-based voice activity detection (Gate 9, Phase 9B;
 * demo-build-spec.md §18 Phase B/C).
 *
 * Runs entirely in the browser on the same normalized PCM16 stream the
 * transport uses — no cloud service is involved in deciding when someone is
 * speaking. The detector is deliberately simple and inspectable:
 *
 *   - RMS energy per pushed chunk, against an adaptive noise floor
 *     (exponential moving average of non-speech energy) with an absolute
 *     minimum so silence in a quiet room never triggers.
 *   - Speech starts after `attackMs` of consecutive voiced audio, and the
 *     preceding `prerollMs` of audio is handed back so the first syllable
 *     is not clipped off the turn.
 *   - Speech ends after `hangoverMs` of continuous silence (configurable
 *     end-of-turn pause), or unconditionally at `maxTurnMs` so a noisy
 *     environment cannot hold a turn open forever (the server enforces its
 *     own 60 s cap regardless; this local cap is deliberately tighter).
 *   - `suspend()` gates the detector for half-duplex operation: while
 *     translated speech is playing, the detector reports nothing at all,
 *     which is the primary echo control (§64 recapture avoidance).
 *
 * All thresholds are configuration, not constants, and the defaults are
 * engineering choices to be tuned against real rooms — recorded as
 * assumption A-014, not presented as measured optimums.
 */

export interface VadConfig {
  /** Absolute RMS floor (0..1 of full scale) below which nothing is voice. */
  minRms: number;
  /** Voice threshold = max(minRms, noiseFloor × noiseRatio). */
  noiseRatio: number;
  /** EMA coefficient for the noise floor (per chunk, non-speech only). */
  noiseAdaptation: number;
  /** Continuous voiced audio required to declare speech start. */
  attackMs: number;
  /** Continuous silence required to declare the turn ended. */
  hangoverMs: number;
  /** Hard local cap on a single turn. */
  maxTurnMs: number;
  /** Audio kept before speech start so the first syllable survives. */
  prerollMs: number;
  /**
   * After reset/resume, the detector only listens and adapts its noise
   * floor for this long before it may emit events. Without it, a steady
   * background hum present from the first frame triggers before the floor
   * has learned it (found by a Gate 9 unit test).
   */
  calibrationMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  minRms: 0.015,
  noiseRatio: 3,
  noiseAdaptation: 0.05,
  attackMs: 90,
  hangoverMs: 900,
  maxTurnMs: 30_000,
  prerollMs: 240,
  calibrationMs: 400,
};

export type VadEvent =
  | { type: 'speech-start'; preroll: Int16Array[] }
  | { type: 'speech-end'; reason: 'silence' | 'max-turn' }
  | null;

export function rmsOf(samples: Int16Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = (samples[i] ?? 0) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export class EnergyVad {
  private readonly config: VadConfig;
  private readonly sampleRateHz: number;

  private noiseFloor: number;
  private speaking = false;
  private suspended = false;
  private voicedMs = 0;
  private silentMs = 0;
  private turnMs = 0;
  private readonly preroll: { samples: Int16Array; ms: number }[] = [];
  private prerollTotalMs = 0;
  private calibrationRemainingMs = 0;

  constructor(sampleRateHz: number, config: Partial<VadConfig> = {}) {
    this.sampleRateHz = sampleRateHz;
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    this.noiseFloor = this.config.minRms;
    this.calibrationRemainingMs = this.config.calibrationMs;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Half-duplex gate: while suspended nothing is detected or buffered. */
  suspend(): void {
    this.suspended = true;
    this.resetTurnState();
  }

  resume(): void {
    this.suspended = false;
    // Re-calibrate briefly: the acoustic scene may have changed while the
    // detector was gated (e.g. translated speech just played).
    this.calibrationRemainingMs = this.config.calibrationMs;
  }

  reset(): void {
    this.resetTurnState();
    this.noiseFloor = this.config.minRms;
    this.calibrationRemainingMs = this.config.calibrationMs;
  }

  private resetTurnState(): void {
    this.speaking = false;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.turnMs = 0;
    this.preroll.length = 0;
    this.prerollTotalMs = 0;
  }

  /**
   * Feed one chunk of normalized PCM16. Returns a state transition, or
   * null when nothing changed.
   */
  push(samples: Int16Array): VadEvent {
    if (this.suspended || samples.length === 0) {
      return null;
    }
    const chunkMs = (samples.length / this.sampleRateHz) * 1000;
    const rms = rmsOf(samples);

    if (this.calibrationRemainingMs > 0) {
      // Listen-only: learn the room, emit nothing.
      this.calibrationRemainingMs -= chunkMs;
      this.noiseFloor =
        this.noiseFloor * (1 - this.config.noiseAdaptation) +
        rms * this.config.noiseAdaptation;
      return null;
    }

    const threshold = Math.max(
      this.config.minRms,
      this.noiseFloor * this.config.noiseRatio,
    );
    const voiced = rms >= threshold;

    if (!this.speaking) {
      // Keep the rolling pre-speech buffer.
      this.preroll.push({ samples, ms: chunkMs });
      this.prerollTotalMs += chunkMs;
      while (
        this.prerollTotalMs > this.config.prerollMs &&
        this.preroll.length > 1
      ) {
        const dropped = this.preroll.shift();
        this.prerollTotalMs -= dropped?.ms ?? 0;
      }

      if (voiced) {
        this.voicedMs += chunkMs;
        if (this.voicedMs >= this.config.attackMs) {
          this.speaking = true;
          this.turnMs = 0;
          this.silentMs = 0;
          const preroll = this.preroll.map((entry) => entry.samples);
          this.preroll.length = 0;
          this.prerollTotalMs = 0;
          return { type: 'speech-start', preroll };
        }
      } else {
        this.voicedMs = 0;
        // Only non-speech audio adapts the noise floor, so the floor never
        // learns speech as background.
        this.noiseFloor =
          this.noiseFloor * (1 - this.config.noiseAdaptation) +
          rms * this.config.noiseAdaptation;
      }
      return null;
    }

    // Speaking.
    this.turnMs += chunkMs;
    if (this.turnMs >= this.config.maxTurnMs) {
      this.resetTurnState();
      return { type: 'speech-end', reason: 'max-turn' };
    }
    if (voiced) {
      this.silentMs = 0;
    } else {
      this.silentMs += chunkMs;
      if (this.silentMs >= this.config.hangoverMs) {
        this.resetTurnState();
        return { type: 'speech-end', reason: 'silence' };
      }
    }
    return null;
  }
}

/**
 * In-band DTMF detection: finds keypad tones in the caller's audio.
 *
 * Used where Twilio does not report keypresses, i.e. during a human call
 * (`<Dial>`), on the one-way copy of the caller's audio. Samples are
 * examined in memory and dropped; nothing is kept but the last window.
 *
 * Method: a 205-sample (25.6 ms at 8 kHz) Goertzel window, evaluated every
 * 64 samples (8 ms), at the 8 DTMF frequencies. A window holds a key when:
 *   - exactly one row and one column tone stand out (each ≥ 6 dB above the
 *     other tones of its group) and each is above an absolute level;
 *   - the two tones are within 8 dB of each other (twist);
 *   - together they carry most of the window's energy, so speech, music and
 *     noise, whose energy is spread out, do not qualify;
 *   - the column tone has no strong second harmonic (voiced speech does).
 *     Row tones are not checked: their second harmonics (1394–1882 Hz) sit
 *     within 1.5 bins of column tones, whose leakage would reject real keys.
 * A key is reported once, when 3 consecutive windows hold it, and can be
 * reported again only after 3 consecutive windows without it, so a long
 * press counts once and presses separated by a short gap count separately.
 *
 * Measured limits (8 kHz, after μ-law): a tone of 33 ms or more is always
 * detected, one under 25 ms never is (ITU-T Q.24: accept ≥ 40 ms, reject
 * < 23 ms). A gap of 16 ms or more separates presses (so a dropout that
 * long in the middle of one press counts it twice). Frequencies within ±1 %
 * of nominal are accepted; beyond about ±1.5 % the high tones may be missed
 * (digital keypads and network-regenerated tones are well inside ±1 %).
 * Twist up to 8 dB. Per-tone level down to about −40 dBFS (amplitude 0.01).
 */

const ROWS = [697, 770, 852, 941] as const;
const COLUMNS = [1209, 1336, 1477, 1633] as const;
const KEYS = ['123A', '456B', '789C', '*0#D'] as const;

/** Window and hop at 8 kHz; scaled for other rates. */
const WINDOW_AT_8K = 205;
const HOP_AT_8K = 64;
/** Consecutive windows needed to accept a key, and to release it. */
const ONSET_WINDOWS = 3;
const RELEASE_WINDOWS = 3;

/** Per-tone power floor (A²/2 for amplitude A of full scale): A ≥ 0.008, ≈ −42 dBFS. */
const MIN_TONE_POWER = 0.5 * 0.008 * 0.008;
/** The strongest tone of a group must exceed the others by this power ratio (6 dB). */
const MIN_PEAK_RATIO = 4;
/** Row and column powers within 8 dB of each other. */
const MAX_TWIST_RATIO = 10 ** 0.8;
/** Row + column must carry at least this share of the window's power. */
const MIN_TONE_SHARE = 0.65;
/** The column tone's second harmonic must be this far below it (15 dB). */
const MAX_HARMONIC_RATIO = 10 ** -1.5;

export class DtmfToneDetector {
  private readonly window: Float64Array;
  private readonly hop: number;
  private readonly rowCoeffs: number[];
  private readonly columnCoeffs: number[];
  private readonly columnHarmonicCoeffs: number[];
  /** Ring buffer position of the oldest sample; also the next write. */
  private position = 0;
  private filled = 0;
  private sinceHop = 0;
  /** The key the last windows agreed on, and for how many windows. */
  private candidate: string | null = null;
  private candidateRun = 0;
  /** The key currently reported as pressed. */
  private held: string | null = null;
  private missRun = 0;

  constructor(sampleRateHz = 8000) {
    const scale = sampleRateHz / 8000;
    this.window = new Float64Array(Math.round(WINDOW_AT_8K * scale));
    this.hop = Math.max(1, Math.round(HOP_AT_8K * scale));
    const coeff = (hz: number) =>
      2 * Math.cos((2 * Math.PI * hz) / sampleRateHz);
    this.rowCoeffs = ROWS.map(coeff);
    this.columnCoeffs = COLUMNS.map(coeff);
    this.columnHarmonicCoeffs = COLUMNS.map((hz) => coeff(2 * hz));
  }

  /** Feed audio of any length; returns the keys whose press began in it. */
  push(samples: Int16Array): string[] {
    const keys: string[] = [];
    const size = this.window.length;
    for (let i = 0; i < samples.length; i++) {
      this.window[this.position] = (samples[i] ?? 0) / 32768;
      this.position = (this.position + 1) % size;
      this.filled = Math.min(size, this.filled + 1);
      this.sinceHop += 1;
      if (this.filled === size && this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        const key = this.track(this.analyse());
        if (key !== null) {
          keys.push(key);
        }
      }
    }
    return keys;
  }

  /** Debounce: per-window verdicts → one key per press. */
  private track(key: string | null): string | null {
    if (key !== null && key === this.candidate) {
      this.candidateRun += 1;
    } else {
      this.candidate = key;
      this.candidateRun = key === null ? 0 : 1;
    }
    if (this.held !== null) {
      if (key === this.held) {
        this.missRun = 0;
        return null;
      }
      this.missRun += 1;
      if (this.missRun < RELEASE_WINDOWS) {
        return null;
      }
      this.held = null;
    }
    if (key !== null && this.candidateRun >= ONSET_WINDOWS) {
      this.held = key;
      this.missRun = 0;
      return key;
    }
    return null;
  }

  /** The key this window holds, or null. */
  private analyse(): string | null {
    const size = this.window.length;
    let total = 0;
    for (let i = 0; i < size; i++) {
      const x = this.window[i] ?? 0;
      total += x * x;
    }
    total /= size;
    if (total < 2 * MIN_TONE_POWER) {
      return null;
    }
    const row = this.strongest(this.rowCoeffs);
    const column = this.strongest(this.columnCoeffs);
    if (row === undefined || column === undefined) {
      return null;
    }
    const twist = row.power / column.power;
    if (
      twist > MAX_TWIST_RATIO ||
      twist < 1 / MAX_TWIST_RATIO ||
      row.power + column.power < MIN_TONE_SHARE * total
    ) {
      return null;
    }
    if (
      this.power(this.columnHarmonicCoeffs[column.index] ?? 0) >
      MAX_HARMONIC_RATIO * column.power
    ) {
      return null;
    }
    return KEYS[row.index]?.[column.index] ?? null;
  }

  /** The group's dominant tone, if one clearly stands out above the floor. */
  private strongest(
    coeffs: readonly number[],
  ): { index: number; power: number } | undefined {
    let index = -1;
    let best = 0;
    let second = 0;
    for (let i = 0; i < coeffs.length; i++) {
      const power = this.power(coeffs[i] ?? 0);
      if (power > best) {
        second = best;
        best = power;
        index = i;
      } else if (power > second) {
        second = power;
      }
    }
    if (index < 0 || best < MIN_TONE_POWER || best < MIN_PEAK_RATIO * second) {
      return undefined;
    }
    return { index, power: best };
  }

  /**
   * Goertzel power at one frequency over the window, in time order,
   * normalized so a sine of amplitude A at that frequency gives ≈ A²/2.
   */
  private power(coeff: number): number {
    const size = this.window.length;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < size; i++) {
      const s0 =
        (this.window[(this.position + i) % size] ?? 0) + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return (2 * (s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (size * size);
  }
}

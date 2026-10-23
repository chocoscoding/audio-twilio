/**
 * Recognizes a repeated key, such as `###`, in a stream of keypresses.
 *
 * Shared by the AI call (Twilio `dtmf` events) and the human-call watch
 * stream (tones heard in the caller's audio), so both directions switch on
 * exactly the same rule: `count` presses of `key` in a row, with no other
 * key between them, the first and last no more than `windowMs` apart.
 */

const DEFAULT_KEY = '#';
const DEFAULT_COUNT = 3;
const DEFAULT_WINDOW_MS = 5_000;

export interface KeySequenceOptions {
  key?: string;
  count?: number;
  windowMs?: number;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

export class KeySequence {
  private readonly key: string;
  private readonly count: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** Times of the current run of `key` presses, oldest first. */
  private presses: number[] = [];

  constructor(options: KeySequenceOptions = {}) {
    this.key = options.key ?? DEFAULT_KEY;
    this.count = Math.max(1, Math.floor(options.count ?? DEFAULT_COUNT));
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /** True exactly when this press completes the sequence (which then resets). */
  press(digit: string): boolean {
    if (digit !== this.key) {
      this.reset();
      return false;
    }
    const at = this.now();
    this.presses.push(at);
    // Presses too old to share a window with this one no longer count, so a
    // slow `#`, pause, `##` still completes once the last three are close.
    while (
      this.presses.length > 0 &&
      at - (this.presses[0] ?? at) > this.windowMs
    ) {
      this.presses.shift();
    }
    if (this.presses.length >= this.count) {
      this.reset();
      return true;
    }
    return false;
  }

  reset(): void {
    this.presses = [];
  }
}

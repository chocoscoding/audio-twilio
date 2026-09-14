/**
 * Half-duplex floor control for one call: who speaks next, when a turn opens
 * and closes, and when listening may resume. Same policy as the FourPoints
 * browser auto mode (apps/web/src/conversation/auto-conversation.ts,
 * decision SLICE9-003), adapted to a phone:
 *
 *   handoff    — a cue tone is playing; nothing is heard
 *   listening  — VAD armed for the current speaker
 *   capturing  — turn open; caller audio streams to FourPoints
 *   processing — turn closed; waiting for translated speech to finish playing
 *
 * Caller audio is DISCARDED outside `listening`/`capturing`. That is the echo
 * control: Twilio has no echo cancellation for phone calls, so the gateway
 * never listens while it is playing.
 *
 * Pure logic with injected effects and timers, so it is unit tested without
 * sockets.
 */

import type { Cue } from './audio.js';
import type { EnergyVad } from './vad.js';

export type Speaker = 'clinician' | 'patient';
export type FloorPhase =
  'idle' | 'handoff' | 'listening' | 'capturing' | 'processing';

export interface FloorEffects {
  startTurn(speaker: Speaker): void;
  sendAudio(samples: Int16Array): void;
  endTurn(): void;
  /** Play a cue; completion is reported through `playbackDrained()`. */
  playCue(cue: Cue): void;
  isPlaybackIdle(): boolean;
  /**
   * Last step before listening resumes. Call `resume` when ready — straight
   * away, or after replacing the FourPoints session.
   */
  beforeListening(resume: () => void): void;
  /** Returns a cancel function. */
  schedule(callback: () => void, delayMs: number): () => void;
}

/** Silence after playback before listening resumes (web auto mode: 300 ms). */
export const HANDOFF_GUARD_MS = 300;
/** A turn with no result by then is treated as failed; the floor never wedges. */
export const PROCESSING_TIMEOUT_MS = 20_000;

export class Floor {
  private phase: FloorPhase = 'idle';
  private speaker: Speaker = 'clinician';
  private turnEnded = false;
  private spoke = false;
  private failed = false;
  private listenPending = false;
  private cancelGuard: (() => void) | null = null;
  private cancelWatchdog: (() => void) | null = null;

  constructor(
    private readonly vad: Pick<
      EnergyVad,
      'push' | 'suspend' | 'resume' | 'reset'
    >,
    private readonly effects: FloorEffects,
  ) {}

  get currentPhase(): FloorPhase {
    return this.phase;
  }

  get currentSpeaker(): Speaker {
    return this.speaker;
  }

  /** Translated speech is only accepted for a turn that is being processed. */
  get acceptsSpeech(): boolean {
    return this.phase === 'processing';
  }

  /** The FourPoints conversation is ready: cue the clinician, then listen. */
  start(): void {
    this.vad.reset();
    this.vad.suspend();
    this.handoff('clinician');
  }

  stop(): void {
    this.cancelGuard?.();
    this.cancelWatchdog?.();
    this.cancelGuard = null;
    this.cancelWatchdog = null;
    this.listenPending = false;
    this.vad.suspend();
    this.phase = 'idle';
  }

  /** Caller audio (8 kHz PCM16). */
  audio(samples: Int16Array): void {
    if (this.phase === 'listening') {
      const event = this.vad.push(samples);
      if (event?.type === 'speech-start') {
        this.effects.startTurn(this.speaker);
        // The preroll ends with this chunk, so the turn misses no syllable.
        for (const chunk of event.preroll) {
          this.effects.sendAudio(chunk);
        }
        this.phase = 'capturing';
      }
      return;
    }
    if (this.phase === 'capturing') {
      this.effects.sendAudio(samples);
      if (this.vad.push(samples)?.type === 'speech-end') {
        this.effects.endTurn();
        this.vad.suspend();
        this.phase = 'processing';
        this.turnEnded = false;
        this.spoke = false;
        this.failed = false;
        this.cancelWatchdog = this.effects.schedule(() => {
          this.cancelWatchdog = null;
          this.failed = true;
          this.turnEnded = true;
          this.settle();
        }, PROCESSING_TIMEOUT_MS);
      }
    }
    // handoff / processing / idle: discarded (echo gate).
  }

  dtmf(digit: string): void {
    if (digit === '*' && this.phase === 'listening') {
      this.vad.suspend();
      this.handoff(this.other());
    }
  }

  /** Translated speech for the current turn started playing out. */
  speechStarted(): void {
    if (this.phase === 'processing') {
      this.spoke = true;
    }
  }

  /** FourPoints declined to speak the turn (quality gate) or reported an error. */
  turnFailed(): void {
    if (this.phase === 'processing') {
      this.failed = true;
    }
  }

  /** FourPoints finished the turn (`metrics.turn`); all its speech was sent. */
  turnFinished(): void {
    if (this.phase !== 'processing') {
      return;
    }
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
    this.turnEnded = true;
    this.settle();
  }

  /** The FourPoints session dropped: fail any open or pending turn now. */
  abortTurn(): void {
    if (this.phase === 'capturing') {
      this.vad.suspend();
      this.phase = 'processing';
      this.spoke = false;
    }
    if (this.phase !== 'processing') {
      return;
    }
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
    this.failed = true;
    this.turnEnded = true;
    this.settle();
  }

  /** Twilio has played everything queued so far. */
  playbackDrained(): void {
    this.settle();
  }

  private settle(): void {
    if (!this.effects.isPlaybackIdle()) {
      return;
    }
    if (this.phase === 'processing' && this.turnEnded) {
      if (this.spoke) {
        this.handoff(this.other());
      } else if (this.failed) {
        this.phase = 'handoff';
        this.effects.playCue('repeat'); // same speaker tries again
      } else {
        this.phase = 'handoff'; // nothing recognised: just listen again
        this.scheduleListening();
      }
      return;
    }
    if (this.phase === 'handoff') {
      this.scheduleListening();
    }
  }

  private handoff(next: Speaker): void {
    this.speaker = next;
    this.phase = 'handoff';
    this.effects.playCue(next);
  }

  private scheduleListening(): void {
    if (this.listenPending) {
      return;
    }
    this.listenPending = true;
    this.cancelGuard = this.effects.schedule(() => {
      this.cancelGuard = null;
      this.effects.beforeListening(() => {
        if (!this.listenPending || this.phase !== 'handoff') {
          return;
        }
        this.listenPending = false;
        this.vad.resume(); // re-calibrates before it can trigger
        this.phase = 'listening';
      });
    }, HANDOFF_GUARD_MS);
  }

  private other(): Speaker {
    return this.speaker === 'clinician' ? 'patient' : 'clinician';
  }
}

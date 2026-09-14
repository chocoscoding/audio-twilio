import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Cue } from './audio.js';
import {
  Floor,
  HANDOFF_GUARD_MS,
  PROCESSING_TIMEOUT_MS,
  type FloorEffects,
} from './floor.js';
import { EnergyVad } from './vad.js';

/** 20 ms at 8 kHz. */
function frame(amplitude: number): Int16Array {
  const out = new Int16Array(160);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(amplitude * 32767) * (i % 2 === 0 ? 1 : -1);
  }
  return out;
}
const SPEECH = frame(0.3);
const SILENCE = frame(0);

function setup() {
  const events: string[] = [];
  let framesSent = 0;
  let queuedPlayback = 0;
  const effects: FloorEffects = {
    startTurn: (speaker) => events.push(`turn:${speaker}`),
    sendAudio: () => {
      framesSent += 1;
    },
    endTurn: () => events.push('turn.end'),
    playCue: (cue: Cue) => {
      events.push(`cue:${cue}`);
      queuedPlayback += 1;
    },
    isPlaybackIdle: () => queuedPlayback === 0,
    beforeListening: (resume) => resume(),
    schedule: (callback, delayMs) => {
      const id = setTimeout(callback, delayMs);
      return () => clearTimeout(id);
    },
  };
  const vad = new EnergyVad(8000, {
    calibrationMs: 0,
    attackMs: 40,
    hangoverMs: 100,
  });
  const floor = new Floor(vad, effects);

  const push = (samples: Int16Array, count: number) => {
    for (let i = 0; i < count; i++) {
      floor.audio(samples);
    }
  };
  /** Everything queued has played: Twilio echoed the last mark. */
  const played = () => {
    queuedPlayback = 0;
    floor.playbackDrained();
    vi.advanceTimersByTime(HANDOFF_GUARD_MS);
  };
  const speakTurn = () => {
    push(SPEECH, 3);
    push(SILENCE, 5);
  };
  return {
    floor,
    events,
    push,
    played,
    speakTurn,
    queueSpeech: () => {
      queuedPlayback += 1;
      floor.speechStarted();
    },
    frames: () => framesSent,
  };
}

describe('Floor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cues the clinician first and ignores audio until the cue has played', () => {
    const t = setup();
    t.floor.start();
    expect(t.events).toEqual(['cue:clinician']);
    t.push(SPEECH, 10);
    expect(t.frames()).toBe(0);
    t.played();
    expect(t.floor.currentPhase).toBe('listening');
  });

  it('opens a turn on speech and closes it after the silence hangover', () => {
    const t = setup();
    t.floor.start();
    t.played();
    t.speakTurn();
    expect(t.events).toEqual(['cue:clinician', 'turn:clinician', 'turn.end']);
    expect(t.floor.currentPhase).toBe('processing');
    expect(t.frames()).toBeGreaterThan(0);
  });

  it('discards caller audio while a translation is processing or playing (echo gate)', () => {
    const t = setup();
    t.floor.start();
    t.played();
    t.speakTurn();
    const sent = t.frames();
    t.queueSpeech();
    t.push(SPEECH, 50);
    expect(t.frames()).toBe(sent);
    expect(t.events.filter((e) => e.startsWith('turn:'))).toHaveLength(1);
  });

  it('hands the floor to the other speaker after the translation has played', () => {
    const t = setup();
    t.floor.start();
    t.played();
    t.speakTurn();
    t.queueSpeech();
    t.floor.turnFinished();
    expect(t.floor.currentPhase).toBe('processing'); // still playing
    t.played();
    expect(t.events.at(-1)).toBe('cue:patient');
    t.played();
    expect(t.floor.currentPhase).toBe('listening');
    expect(t.floor.currentSpeaker).toBe('patient');
  });

  it('asks the same speaker to repeat when the turn was not spoken', () => {
    const t = setup();
    t.floor.start();
    t.played();
    t.speakTurn();
    t.floor.turnFailed();
    t.floor.turnFinished();
    expect(t.events.at(-1)).toBe('cue:repeat');
    t.played();
    expect(t.floor.currentPhase).toBe('listening');
    expect(t.floor.currentSpeaker).toBe('clinician');
  });

  it('silently resumes listening when nothing was recognised', () => {
    const t = setup();
    t.floor.start();
    t.played();
    t.speakTurn();
    t.floor.turnFinished();
    vi.advanceTimersByTime(HANDOFF_GUARD_MS);
    expect(t.events.at(-1)).toBe('turn.end');
    expect(t.floor.currentPhase).toBe('listening');
  });

  it('switches the next speaker on star, only while listening', () => {
    const t = setup();
    t.floor.start();
    t.played();
    t.floor.dtmf('*');
    expect(t.events.at(-1)).toBe('cue:patient');
    t.played();
    t.push(SPEECH, 3); // capturing now
    t.floor.dtmf('*');
    expect(t.events.at(-1)).toBe('turn:patient');
  });

  it('never wedges: a turn with no result is failed by the watchdog', () => {
    const t = setup();
    t.floor.start();
    t.played();
    t.speakTurn();
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS);
    expect(t.events.at(-1)).toBe('cue:repeat');
    t.floor.turnFinished(); // late result is ignored
    expect(t.events.filter((e) => e === 'cue:repeat')).toHaveLength(1);
  });

  it('stops cleanly', () => {
    const t = setup();
    t.floor.start();
    t.played();
    t.speakTurn();
    t.floor.stop();
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS);
    t.push(SPEECH, 10);
    expect(t.floor.currentPhase).toBe('idle');
    expect(t.events.at(-1)).toBe('turn.end');
  });
});

/**
 * Per-turn latency measurement (demo-build-spec.md §27).
 *
 * All values are measured timestamps in epoch milliseconds. Latency is a
 * product metric: values are captured, never hard-coded or estimated. A
 * field is absent when its pipeline stage did not occur for the turn.
 */
export interface TurnTimestamps {
  speechStart?: number;
  firstAudioFrameSent?: number;
  speechEnd?: number;
  firstAsrPartial?: number;
  asrFinal?: number;
  translationStart?: number;
  translationComplete?: number;
  qualityValidationComplete?: number;
  ttsStart?: number;
  ttsFirstByte?: number;
  playbackStart?: number;
  playbackComplete?: number;
}

/**
 * Derived per-turn latencies in milliseconds (demo-build-spec.md §27).
 * Each value is computed from measured timestamps; absent when the
 * contributing timestamps were not captured.
 */
export interface TurnLatencies {
  firstAsrPartialMs?: number;
  asrFinalizationMs?: number;
  translationMs?: number;
  validationMs?: number;
  ttsFirstByteMs?: number;
  speechEndToPlaybackMs?: number;
  totalTurnMs?: number;
}

/**
 * Measured audio-frame arrival statistics for one turn, computed by the
 * realtime server (Slice 1 acceptance: frame timing is measurable). All
 * values are measured, never estimated.
 */
export interface AudioFrameStats {
  framesReceived: number;
  bytesReceived: number;
  /** Count of discontinuities in the per-turn frame sequence numbers. */
  sequenceGaps: number;
  /** Audio duration implied by received samples at the declared rate. */
  audioDurationMs: number;
  /** Wall-clock span between first and last frame arrival (2+ frames). */
  receiveSpanMs?: number;
  /** Mean inter-frame arrival interval (2+ frames). */
  meanInterFrameMs?: number;
  /** Worst inter-frame arrival interval (2+ frames). */
  maxInterFrameMs?: number;
}

export interface TurnMetrics {
  timestamps: TurnTimestamps;
  latencies: TurnLatencies;
  /** Present when the turn streamed audio to the server. */
  audio?: AudioFrameStats;
}

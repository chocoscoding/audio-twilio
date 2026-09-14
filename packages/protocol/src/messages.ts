/**
 * FourPoints WebSocket control-message protocol (demo-build-spec.md §21).
 *
 * Control messages are typed JSON text frames. Audio travels as binary
 * WebSocket frames, not JSON; the exact binary frame layout is specified in
 * Slice 1 alongside the audio transport implementation.
 *
 * Wire types are deliberately self-contained (no dependency on internal
 * provider types) so the browser bundle carries only the wire contract.
 */

import type { TurnMetrics } from './metrics.js';

export const PROTOCOL_VERSION = 1;

/** Conversation states surfaced to the user (demo-build-spec.md §43). */
export type ConversationState =
  | 'connecting'
  | 'ready'
  | 'listening'
  | 'transcribing'
  | 'translating'
  | 'validating'
  | 'speaking'
  | 'waiting'
  | 'reconnecting'
  | 'translation_unavailable'
  | 'ended';

/** Structured error categories sent to the browser (demo-build-spec.md §44). */
export type ErrorCategory =
  | 'ASR_TIMEOUT'
  | 'ASR_PROVIDER_ERROR'
  | 'ASR_UNSUPPORTED_LANGUAGE'
  | 'TRANSLATION_PROVIDER_ERROR'
  | 'TRANSLATION_EMPTY'
  | 'TRANSLATION_TIMEOUT'
  | 'QUALITY_NUMERIC_MISMATCH'
  | 'QUALITY_VALIDATION_FAILED'
  | 'TTS_PROVIDER_ERROR'
  | 'TTS_UNSUPPORTED_LANGUAGE'
  | 'WEBSOCKET_DISCONNECTED'
  | 'INVALID_LANGUAGE_ROUTE'
  | 'UNAUTHORIZED_SESSION'
  | 'PROTOCOL_ERROR'
  /** Client speaks a protocol version this server does not implement. */
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  /** A server-enforced resource bound was exceeded (size, turn, session). */
  | 'LIMIT_EXCEEDED';

/** Wire form of a quality validation outcome. */
export interface QualityOutcome {
  status: 'PASS' | 'WARN' | 'FAIL';
  reasons: string[];
}

/**
 * Capability tier as shown to the browser (demo-build-spec.md §9).
 * Mirrors (intentionally, SLICE0-004) the language-core CapabilityTier.
 */
export type WireCapabilityTier =
  'FULL_VOICE' | 'SPEECH_TEXT' | 'TEXT_TRANSLATION' | 'EXPERIMENTAL';

/**
 * Validation status as shown to the browser (demo-build-spec.md §33).
 * Deliberately separate from the capability tier: a language can be
 * FULL_VOICE and still UNTESTED, and the UI must be able to say so.
 */
export type WireValidationStatus =
  'UNTESTED' | 'EXPERIMENTAL' | 'TECHNICALLY_VALIDATED' | 'DEMO_VALIDATED';

/**
 * What the browser is told about a language: a PROJECTION of the registry
 * entry, never the entry itself.
 *
 * Provider identities, ASR locales, translation language codes, TTS voices
 * and engines are deliberately absent — they are routing configuration and
 * stay server-side (§13: the browser must not select providers; §42: no
 * provider logic in UI components). Changing a provider, voice or locale
 * therefore cannot require a frontend change, because the frontend never
 * saw them.
 */
export interface WireLanguageCapability {
  /** Stable FourPoints language identifier, e.g. "es-US". */
  languageId: string;
  displayName: string;
  /** What a participant using this language can do. */
  input: { speech: boolean; text: boolean };
  output: { speech: boolean; text: boolean };
  capabilityTier: WireCapabilityTier;
  validationStatus: WireValidationStatus;
}

/**
 * Wire form of the audio format for a turn. Declared once in `turn.start`;
 * binary audio frames within the turn carry samples in this format.
 * Mirrors (intentionally, see SLICE0-004) the provider-interfaces
 * AudioFormat shape.
 */
export interface WireAudioFormat {
  encoding: 'pcm_s16le';
  sampleRateHz: number;
  channels: 1;
}

// ---------------------------------------------------------------------------
// Client → server control messages
// ---------------------------------------------------------------------------

export interface SessionStartMessage {
  type: 'session.start';
  protocolVersion: number;
}

export interface ConversationStartMessage {
  type: 'conversation.start';
  clinicianLanguageId: string;
  patientLanguageId: string;
}

export interface TurnStartMessage {
  type: 'turn.start';
  /** Which participant is speaking this turn. */
  speaker: 'clinician' | 'patient';
  /** Client timestamp of speech start, epoch milliseconds. */
  speechStartMs: number;
  /** Format of the binary audio frames streamed during this turn. */
  audioFormat: WireAudioFormat;
}

export interface TurnEndMessage {
  type: 'turn.end';
  /** Client timestamp of speech end, epoch milliseconds. */
  speechEndMs: number;
}

export interface LanguageChangeMessage {
  type: 'language.change';
  participant: 'clinician' | 'patient';
  languageId: string;
}

export interface ConversationEndMessage {
  type: 'conversation.end';
}

export interface SessionEndMessage {
  type: 'session.end';
}

export type ClientMessage =
  | SessionStartMessage
  | ConversationStartMessage
  | TurnStartMessage
  | TurnEndMessage
  | LanguageChangeMessage
  | ConversationEndMessage
  | SessionEndMessage;

// ---------------------------------------------------------------------------
// Server → client messages
// ---------------------------------------------------------------------------

export interface SessionReadyMessage {
  type: 'session.ready';
  protocolVersion: number;
  sessionId: string;
}

/**
 * The languages this deployment can actually serve, plus the pair a client
 * should open with. Sent once the session is ready, so the browser never
 * needs a built-in language list (§42).
 */
export interface LanguagesAvailableMessage {
  type: 'languages.available';
  languages: WireLanguageCapability[];
  /** Server-configured opening pair; the browser holds no default of its own. */
  defaultClinicianLanguageId: string;
  defaultPatientLanguageId: string;
}

export interface ConversationReadyMessage {
  type: 'conversation.ready';
  conversationId: string;
}

/**
 * The language pair currently in effect. Sent when a conversation starts and
 * after every accepted `language.change`, so the browser renders the
 * server's state rather than assuming its own request was applied.
 */
export interface ConversationLanguagesMessage {
  type: 'conversation.languages';
  conversationId: string;
  clinicianLanguageId: string;
  patientLanguageId: string;
}

export interface ListeningMessage {
  type: 'listening';
  turnId: string;
}

export interface TranscriptPartialMessage {
  type: 'transcript.partial';
  turnId: string;
  text: string;
}

export interface TranscriptFinalMessage {
  type: 'transcript.final';
  turnId: string;
  text: string;
}

export interface TranslationStartedMessage {
  type: 'translation.started';
  turnId: string;
}

export interface TranslationFinalMessage {
  type: 'translation.final';
  turnId: string;
  text: string;
}

export interface QualityResultMessage {
  type: 'quality.result';
  turnId: string;
  result: QualityOutcome;
}

export interface TtsStartedMessage {
  type: 'tts.started';
  turnId: string;
  /**
   * Format of the binary TTS frames that follow, until `tts.ended`.
   * Declared per utterance rather than per frame, mirroring `turn.start`.
   */
  audioFormat: WireAudioFormat;
}

export interface TtsEndedMessage {
  type: 'tts.ended';
  turnId: string;
}

export interface MetricsTurnMessage {
  type: 'metrics.turn';
  turnId: string;
  metrics: TurnMetrics;
}

export interface WarningMessage {
  type: 'warning';
  category: ErrorCategory;
  /** User-safe message; never a raw provider error (spec §44). */
  message: string;
}

export interface ErrorMessage {
  type: 'error';
  category: ErrorCategory;
  /** User-safe message; never a raw provider error (spec §44). */
  message: string;
}

export interface ReconnectingMessage {
  type: 'reconnecting';
}

export type ServerMessage =
  | SessionReadyMessage
  | LanguagesAvailableMessage
  | ConversationReadyMessage
  | ConversationLanguagesMessage
  | ListeningMessage
  | TranscriptPartialMessage
  | TranscriptFinalMessage
  | TranslationStartedMessage
  | TranslationFinalMessage
  | QualityResultMessage
  | TtsStartedMessage
  | TtsEndedMessage
  | MetricsTurnMessage
  | WarningMessage
  | ErrorMessage
  | ReconnectingMessage;

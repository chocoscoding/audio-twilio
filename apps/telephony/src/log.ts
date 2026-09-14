import { createHash } from 'node:crypto';

export type LogFields = Record<string, string | number | boolean | undefined>;

/**
 * One JSON line per event. Callers pass identifiers and measurements only —
 * never audio, transcripts, translations, phone numbers or credentials.
 */
export function log(event: string, fields: LogFields = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
  );
}

/** Stable, non-reversible correlation id for a Twilio SID. */
export function redactId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

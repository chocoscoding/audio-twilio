/**
 * Minimal TwiML rendering. TwiML is plain XML, so a tiny escaping builder
 * replaces the twilio SDK here; every text and attribute value is escaped.
 */

type AttributeValue = string | number | boolean | undefined;

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/** Render an element. Children must already be rendered XML. */
export function element(
  name: string,
  attributes: Record<string, AttributeValue> = {},
  ...children: string[]
): string {
  const attrs = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join('');
  return children.length === 0
    ? `<${name}${attrs}/>`
    : `<${name}${attrs}>${children.join('')}</${name}>`;
}

/**
 * Polly generative Joanna: natural, and the same voice FourPoints uses for
 * English translations, so the call sounds like one person throughout.
 * Google.en-US-Chirp3-HD-* voices sound a touch richer but add an audible
 * pause before every prompt while Twilio synthesizes them.
 *
 * PROMPT_VOICE overrides it without a code change (e.g.
 * `Polly.Joanna-Neural`), for when a voice clips the start of prompts.
 */
export const PROMPT_VOICE =
  process.env['PROMPT_VOICE']?.trim() || 'Polly.Joanna-Generative';

/** Spoken prompt in one consistent voice. */
export function say(text: string): string {
  return element(
    'Say',
    { voice: PROMPT_VOICE, language: 'en-US' },
    escapeXml(text),
  );
}

/**
 * Spoken before the first prompt of every TwiML document. Phone networks
 * that mute the line during silence reopen it a moment AFTER speech starts,
 * which clipped the first word or two of every prompt ("...Points
 * interpretation"). Silence before the prompt does not help; a throwaway
 * phrase does, because the clipping eats it instead of the real words.
 * PROMPT_LEAD_IN overrides it; set it empty to disable.
 */
export const PROMPT_LEAD_IN = (
  process.env['PROMPT_LEAD_IN'] ?? 'One moment please.'
).trim();

export function response(...verbs: string[]): string {
  const body = element('Response', {}, ...verbs);
  const withLeadIn =
    PROMPT_LEAD_IN === ''
      ? body
      : body.replace(
          /<Say([^>]*)>/,
          (_match, attrs: string) =>
            `<Say${attrs}>${escapeXml(PROMPT_LEAD_IN)} `,
        );
  return `<?xml version="1.0" encoding="UTF-8"?>${withLeadIn}`;
}

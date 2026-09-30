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
 */
export const PROMPT_VOICE = 'Polly.Joanna-Generative';

/** Spoken prompt in one consistent voice. */
export function say(text: string): string {
  return element(
    'Say',
    { voice: PROMPT_VOICE, language: 'en-US' },
    escapeXml(text),
  );
}

export function response(...verbs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${element('Response', {}, ...verbs)}`;
}

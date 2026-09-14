import { describe, expect, it } from 'vitest';

import { isValidTwilioSignature, twilioSignature } from './twilio-signature.js';

// Worked example published at https://www.twilio.com/docs/usage/security
const DOC_TOKEN = '12345';
const DOC_URL = 'https://example.com/myapp.php?foo=1&bar=2';
const DOC_PARAMS: [string, string][] = [
  ['Digits', '1234'],
  ['To', '+18005551212'],
  ['From', '+14158675310'],
  ['Caller', '+14158675310'],
  ['CallSid', 'CA1234567890ABCDE'],
];
const DOC_SIGNATURE = 'L/OH5YylLD5NRKLltdqwSvS0BnU=';

describe('twilioSignature', () => {
  it("reproduces Twilio's documented example", () => {
    expect(twilioSignature(DOC_TOKEN, DOC_URL, DOC_PARAMS)).toBe(DOC_SIGNATURE);
  });

  it('does not depend on parameter order', () => {
    const body = new URLSearchParams([...DOC_PARAMS].reverse());
    expect(
      isValidTwilioSignature(DOC_TOKEN, DOC_SIGNATURE, DOC_URL, body),
    ).toBe(true);
  });
});

describe('isValidTwilioSignature', () => {
  it('rejects a tampered parameter', () => {
    const tampered = DOC_PARAMS.map(([k, v]): [string, string] =>
      k === 'Digits' ? [k, '9999'] : [k, v],
    );
    expect(
      isValidTwilioSignature(DOC_TOKEN, DOC_SIGNATURE, DOC_URL, tampered),
    ).toBe(false);
  });

  it('rejects a different URL, token or missing signature', () => {
    expect(
      isValidTwilioSignature(
        DOC_TOKEN,
        DOC_SIGNATURE,
        `${DOC_URL}&x=1`,
        DOC_PARAMS,
      ),
    ).toBe(false);
    expect(
      isValidTwilioSignature('other', DOC_SIGNATURE, DOC_URL, DOC_PARAMS),
    ).toBe(false);
    expect(
      isValidTwilioSignature(DOC_TOKEN, undefined, DOC_URL, DOC_PARAMS),
    ).toBe(false);
    expect(
      isValidTwilioSignature(DOC_TOKEN, 'short', DOC_URL, DOC_PARAMS),
    ).toBe(false);
  });

  it('validates a WebSocket handshake URL with no parameters', () => {
    const url = 'wss://phone.example.com/media';
    const signature = twilioSignature(DOC_TOKEN, url);
    expect(isValidTwilioSignature(DOC_TOKEN, signature, url)).toBe(true);
  });
});

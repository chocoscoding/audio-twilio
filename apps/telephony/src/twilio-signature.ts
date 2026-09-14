import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * X-Twilio-Signature, as documented at https://www.twilio.com/docs/usage/security:
 * base64(HMAC-SHA1(authToken, url + every POST parameter name and value,
 * sorted by name with case-sensitive ordering)).
 *
 * Implemented on node:crypto rather than the twilio SDK so the gateway's only
 * runtime dependency stays `ws`. The unit test pins Twilio's published
 * worked example, so a divergence from the documented algorithm fails CI.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Iterable<[string, string]> = [],
): string {
  const payload = [...params]
    .sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .reduce((acc, [name, value]) => acc + name + value, url);
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

export function isValidTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Iterable<[string, string]> = [],
): boolean {
  if (signature === undefined || signature.length === 0) {
    return false;
  }
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const received = Buffer.from(signature);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

/**
 * Client for the FourPoints control-plane API's internal phone routes, used
 * only on the organization line (the new number: organization ID, then
 * access code). The caller's phone number is never sent.
 *
 *   resolve(orgNumber, code)  may this call continue, and with what?
 *   line(orgNumber, orgId)    a call on a company's own number: may it go
 *                             straight in, or must the caller enter a code?
 *   usage(event)              start / end of one interpretation leg
 *
 * Authenticated with the gateway's Cognito machine token for the phone
 * scope. Bounded by a timeout; the IVR decides what a failure means
 * (resolve fails closed, usage is logged and the call goes on).
 */

import type { AuthHeaders } from './auth.js';

const TIMEOUT_MS = 5_000;

export type ResolveResult =
  | {
      outcome: 'OK';
      organizationId: string;
      employeeId: string | null;
      aiAllowed: boolean;
      humanAllowed: boolean;
      minutesRemaining: number;
    }
  | {
      outcome: 'INVALID' | 'NOT_ACTIVE' | 'NO_PHONE_ACCESS' | 'QUOTA_EXHAUSTED';
    };

/**
 * A company's own number. CODE_REQUIRED: the organization has an
 * organization-wide code (active or paused), so the caller enters a code as
 * on the shared line. INVALID here also covers an organizationId that does
 * not belong to orgNumber.
 */
export type LineResult = ResolveResult | { outcome: 'CODE_REQUIRED' };

export type UsageEvent =
  | {
      event: 'start';
      callSid: string;
      leg: number;
      organizationId: string;
      employeeId?: string;
      mode: 'AI' | 'HUMAN';
      languageId?: string;
    }
  | {
      event: 'end';
      callSid: string;
      leg: number;
      organizationId: string;
      mode: 'AI' | 'HUMAN';
    };

/** `refused`: the organization can no longer use the line (e.g. paused). */
export type UsageResult = 'recorded' | 'refused' | 'error';

export interface AccessClient {
  resolve(orgNumber: number, code: string): Promise<ResolveResult>;
  line(orgNumber: number, organizationId: string): Promise<LineResult>;
  usage(event: UsageEvent): Promise<UsageResult>;
}

const OUTCOMES = new Set([
  'OK',
  'INVALID',
  'NOT_ACTIVE',
  'NO_PHONE_ACCESS',
  'QUOTA_EXHAUSTED',
]);

/** Throws unless `body` is a well-formed answer with one of `outcomes`. */
function checkOutcome(
  route: string,
  body: Record<string, unknown>,
  outcomes: ReadonlySet<string>,
): void {
  if (typeof body['outcome'] !== 'string' || !outcomes.has(body['outcome'])) {
    throw new Error(`${route} returned an unknown outcome`);
  }
  if (
    body['outcome'] === 'OK' &&
    (typeof body['organizationId'] !== 'string' ||
      typeof body['minutesRemaining'] !== 'number')
  ) {
    throw new Error(`${route} returned an incomplete grant`);
  }
}

const LINE_OUTCOMES = new Set([...OUTCOMES, 'CODE_REQUIRED']);

export function createAccessClient(
  apiBaseUrl: string,
  authHeaders: AuthHeaders,
  fetchImpl: typeof fetch = fetch,
): AccessClient {
  const post = async (path: string, body: unknown) =>
    fetchImpl(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The FourPoints edge WAF refuses requests with no User-Agent.
        'user-agent': 'fourpoints-telephony',
        ...(await authHeaders()),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  return {
    async resolve(orgNumber, code) {
      const res = await post('/internal/phone/resolve', { orgNumber, code });
      if (!res.ok) {
        throw new Error(`resolve returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as Record<string, unknown>;
      checkOutcome('resolve', body, OUTCOMES);
      return body as ResolveResult;
    },

    async line(orgNumber, organizationId) {
      const res = await post('/internal/phone/line', {
        orgNumber,
        organizationId,
      });
      if (!res.ok) {
        throw new Error(`line returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as Record<string, unknown>;
      checkOutcome('line', body, LINE_OUTCOMES);
      return body as LineResult;
    },

    async usage(event) {
      try {
        const res = await post('/internal/phone/usage', event);
        if (res.status === 403 || res.status === 404) {
          return 'refused';
        }
        return res.ok ? 'recorded' : 'error';
      } catch {
        return 'error';
      }
    },
  };
}

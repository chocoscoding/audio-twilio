/**
 * Client for the FourPoints control-plane API's internal phone routes, used
 * only on the organization line (the new number: organization ID, then
 * access code). The caller's phone number is never sent.
 *
 *   resolve(orgNumber, code)  may this call continue, and with what?
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
  usage(event: UsageEvent): Promise<UsageResult>;
}

const OUTCOMES = new Set([
  'OK',
  'INVALID',
  'NOT_ACTIVE',
  'NO_PHONE_ACCESS',
  'QUOTA_EXHAUSTED',
]);

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
      if (
        typeof body['outcome'] !== 'string' ||
        !OUTCOMES.has(body['outcome'])
      ) {
        throw new Error('resolve returned an unknown outcome');
      }
      if (
        body['outcome'] === 'OK' &&
        (typeof body['organizationId'] !== 'string' ||
          typeof body['minutesRemaining'] !== 'number')
      ) {
        throw new Error('resolve returned an incomplete grant');
      }
      return body as ResolveResult;
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

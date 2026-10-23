/**
 * The one Twilio REST operation the gateway needs: take the human
 * interpreter off a call so the caller can move to the AI.
 *
 *   releaseHumanLeg(parentCallSid, twiml)
 *     lists the caller's in-progress child calls (the `<Dial>` leg to the
 *     interpreter) and gives each one new TwiML. The interpreter's leg then
 *     runs that TwiML (e.g. a short notice and `<Hangup/>`), `<Dial>` ends,
 *     and the caller's call continues at its `<Dial action>`.
 *
 * Authenticated with a Twilio API key (HTTP Basic). Bounded by one timeout
 * for the whole operation; never throws: the caller logs the outcome and the
 * human call simply goes on if anything fails.
 */

import { log, redactId } from './log.js';

const API_BASE = 'https://api.twilio.com/2010-04-01';
const DEFAULT_TIMEOUT_MS = 5_000;
/** Twilio refuses inline TwiML longer than this. */
const MAX_TWIML_CHARS = 4_000;
/** A call has few children; more than this is not a `<Dial>` we made. */
const PAGE_SIZE = 20;

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const CALL_SID = /^CA[0-9a-f]{32}$/;

/**
 * `released`: every in-progress child accepted the new TwiML.
 * `none`: no child was in progress (not answered yet, or already gone).
 * `error`: invalid input, HTTP failure, unexpected response or timeout.
 */
export type ReleaseResult = 'released' | 'none' | 'error';

export interface TwilioRest {
  releaseHumanLeg(parentCallSid: string, twiml: string): Promise<ReleaseResult>;
}

export interface TwilioRestOptions {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null;

export const isCallSid = (value: unknown): value is string =>
  typeof value === 'string' && CALL_SID.test(value);

/** Throws on an invalid account SID or missing key: a configuration error. */
export function createTwilioRest(options: TwilioRestOptions): TwilioRest {
  const { accountSid, apiKeySid, apiKeySecret } = options;
  if (!ACCOUNT_SID.test(accountSid)) {
    throw new Error('Twilio account SID is invalid');
  }
  if (apiKeySid === '' || apiKeySecret === '') {
    throw new Error('Twilio API key is missing');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const calls = `${API_BASE}/Accounts/${accountSid}/Calls`;
  const authorization = `Basic ${Buffer.from(
    `${apiKeySid}:${apiKeySecret}`,
  ).toString('base64')}`;

  /** In-progress child call SIDs, or undefined on any failure. */
  const listChildren = async (
    parentCallSid: string,
    signal: AbortSignal,
  ): Promise<string[] | undefined> => {
    const query = new URLSearchParams({
      ParentCallSid: parentCallSid,
      Status: 'in-progress',
      PageSize: String(PAGE_SIZE),
    });
    const res = await fetchImpl(`${calls}.json?${query.toString()}`, {
      method: 'GET',
      headers: { authorization, accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      log('twilio.rest_failed', { step: 'list', status: res.status });
      return undefined;
    }
    const body: unknown = await res.json();
    if (!isJson(body) || !Array.isArray(body['calls'])) {
      log('twilio.rest_failed', { step: 'list', status: 'bad_body' });
      return undefined;
    }
    const children: string[] = [];
    for (const call of body['calls']) {
      // Twilio already filtered; check again rather than redirect a parent
      // or a finished leg because of a misread query.
      if (
        isJson(call) &&
        isCallSid(call['sid']) &&
        call['sid'] !== parentCallSid &&
        call['status'] === 'in-progress' &&
        (call['parent_call_sid'] === undefined ||
          call['parent_call_sid'] === parentCallSid)
      ) {
        children.push(call['sid']);
      }
    }
    return children;
  };

  const updateChild = async (
    childSid: string,
    twiml: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const res = await fetchImpl(`${calls}/${childSid}.json`, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Twiml: twiml }).toString(),
      signal,
    });
    if (!res.ok) {
      log('twilio.rest_failed', { step: 'update', status: res.status });
    }
    return res.ok;
  };

  return {
    async releaseHumanLeg(parentCallSid, twiml) {
      if (
        !isCallSid(parentCallSid) ||
        twiml.trim() === '' ||
        twiml.length > MAX_TWIML_CHARS
      ) {
        return 'error';
      }
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const children = await listChildren(parentCallSid, signal);
        if (children === undefined) {
          return 'error';
        }
        if (children.length === 0) {
          return 'none';
        }
        const updated = await Promise.all(
          children.map((child) => updateChild(child, twiml, signal)),
        );
        return updated.every(Boolean) ? 'released' : 'error';
      } catch (error) {
        log('twilio.rest_failed', {
          call: redactId(parentCallSid),
          step: 'request',
          reason:
            error instanceof Error && error.name === 'TimeoutError'
              ? 'timeout'
              : 'network',
        });
        return 'error';
      }
    },
  };
}

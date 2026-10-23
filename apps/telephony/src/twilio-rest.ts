/**
 * The Twilio REST operations the human-call relay (relay.ts) needs:
 *
 *   getCall(sid)            the number a call arrived on, and its state
 *   createCall(...)         ring the interpreter line with inline TwiML
 *   updateCall(sid, twiml)  give a call new TwiML (a notice, then hang up)
 *   endCall(sid)            hang up, or cancel while it is still ringing
 *
 * Authenticated with a Twilio API key (HTTP Basic). Every request is bounded
 * by a timeout and never throws: callers get `undefined` / `false` and log
 * the outcome. Logs are content-free (no numbers, no TwiML).
 */

import { log } from './log.js';

const API_BASE = 'https://api.twilio.com/2010-04-01';
const DEFAULT_TIMEOUT_MS = 5_000;
/** Twilio refuses inline TwiML longer than this. */
const MAX_TWIML_CHARS = 4_000;

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const CALL_SID = /^CA[0-9a-f]{32}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

export interface CallInfo {
  /** The number the call was placed to (E.164), or '' if Twilio gave none. */
  to: string;
  /** Twilio call status: queued, ringing, in-progress, completed, busy, … */
  status: string;
}

export interface NewCall {
  to: string;
  /** Must be a number on this Twilio account. */
  from: string;
  twiml: string;
  /** Seconds to ring before giving up (Twilio: 5–600). */
  timeoutSeconds: number;
}

export interface TwilioRest {
  getCall(sid: string): Promise<CallInfo | undefined>;
  createCall(call: NewCall): Promise<string | undefined>;
  updateCall(sid: string, twiml: string): Promise<boolean>;
  endCall(sid: string): Promise<boolean>;
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

const validTwiml = (twiml: string) =>
  twiml.trim() !== '' && twiml.length <= MAX_TWIML_CHARS;

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

  /** One bounded request; the parsed JSON body, or undefined on any failure. */
  const request = async (
    step: string,
    url: string,
    form?: Record<string, string>,
  ): Promise<Json | undefined> => {
    try {
      const res = await fetchImpl(url, {
        method: form === undefined ? 'GET' : 'POST',
        headers: {
          authorization,
          accept: 'application/json',
          ...(form === undefined
            ? {}
            : { 'content-type': 'application/x-www-form-urlencoded' }),
        },
        ...(form === undefined
          ? {}
          : { body: new URLSearchParams(form).toString() }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log('twilio.rest_failed', { step, status: res.status });
        return undefined;
      }
      const body: unknown = await res.json();
      if (!isJson(body)) {
        log('twilio.rest_failed', { step, status: 'bad_body' });
        return undefined;
      }
      return body;
    } catch (error) {
      log('twilio.rest_failed', {
        step,
        reason:
          error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : 'network',
      });
      return undefined;
    }
  };

  return {
    async getCall(sid) {
      if (!isCallSid(sid)) {
        return undefined;
      }
      const body = await request('get', `${calls}/${sid}.json`);
      if (body === undefined || typeof body['status'] !== 'string') {
        return undefined;
      }
      return {
        to: typeof body['to'] === 'string' ? body['to'] : '',
        status: body['status'],
      };
    },

    async createCall(call) {
      if (
        !E164.test(call.to) ||
        !E164.test(call.from) ||
        !validTwiml(call.twiml)
      ) {
        return undefined;
      }
      const body = await request('create', `${calls}.json`, {
        To: call.to,
        From: call.from,
        Twiml: call.twiml,
        Timeout: String(Math.min(Math.max(call.timeoutSeconds, 5), 600)),
      });
      return isCallSid(body?.['sid']) ? body['sid'] : undefined;
    },

    async updateCall(sid, twiml) {
      if (!isCallSid(sid) || !validTwiml(twiml)) {
        return false;
      }
      return (
        (await request('update', `${calls}/${sid}.json`, { Twiml: twiml })) !==
        undefined
      );
    },

    async endCall(sid) {
      if (!isCallSid(sid)) {
        return false;
      }
      // `completed` hangs up an answered call; a call still ringing only
      // accepts `canceled`.
      return (
        (await request('end', `${calls}/${sid}.json`, {
          Status: 'completed',
        })) !== undefined ||
        (await request('cancel', `${calls}/${sid}.json`, {
          Status: 'canceled',
        })) !== undefined
      );
    },
  };
}

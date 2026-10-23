import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTwilioRest } from './twilio-rest.js';

const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const CALL = `CA${'1'.repeat(32)}`;
const LEG = `CA${'2'.repeat(32)}`;
const TWIML = '<Response><Hangup/></Response>';
const BASE = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls`;

interface Request {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fake fetch: records requests and answers from `respond`. */
function fakeFetch(
  respond: (request: Request) => Response | Promise<Response>,
) {
  const requests: Request[] = [];
  const fetchImpl = (async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ) => {
    const request: Request = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function client(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createTwilioRest({
    accountSid: ACCOUNT_SID,
    apiKeySid: 'SKtest',
    apiKeySecret: 'secret',
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('createTwilioRest()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a bad account SID or a missing key at creation', () => {
    expect(() =>
      createTwilioRest({
        accountSid: 'AC1',
        apiKeySid: 'SK',
        apiKeySecret: 's',
      }),
    ).toThrow('account SID');
    expect(() =>
      createTwilioRest({
        accountSid: ACCOUNT_SID,
        apiKeySid: '',
        apiKeySecret: 's',
      }),
    ).toThrow('API key');
  });

  it('reads the number a call arrived on, with Basic auth', async () => {
    const f = fakeFetch(() =>
      json({ sid: CALL, to: '+18723047712', status: 'in-progress' }),
    );
    expect(await client(f.fetchImpl).getCall(CALL)).toEqual({
      to: '+18723047712',
      status: 'in-progress',
    });
    expect(f.requests[0]?.url).toBe(`${BASE}/${CALL}.json`);
    expect(f.requests[0]?.method).toBe('GET');
    expect(f.requests[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from('SKtest:secret').toString('base64')}`,
    );
  });

  it('places a call with inline TwiML and a bounded ring time', async () => {
    const f = fakeFetch(() => json({ sid: LEG, status: 'queued' }));
    expect(
      await client(f.fetchImpl).createCall({
        to: '+14342483776',
        from: '+18723047712',
        twiml: TWIML,
        timeoutSeconds: 30,
      }),
    ).toBe(LEG);
    const form = new URLSearchParams(f.requests[0]?.body);
    expect(f.requests[0]?.url).toBe(`${BASE}.json`);
    expect(Object.fromEntries(form)).toEqual({
      To: '+14342483776',
      From: '+18723047712',
      Twiml: TWIML,
      Timeout: '30',
    });
  });

  it('gives a call new TwiML, and ends a call (cancelling if it is still ringing)', async () => {
    const f = fakeFetch((r) =>
      r.body === 'Status=completed'
        ? json({ message: 'not in progress' }, 400)
        : json({ sid: LEG }),
    );
    const rest = client(f.fetchImpl);
    expect(await rest.updateCall(LEG, TWIML)).toBe(true);
    expect(new URLSearchParams(f.requests[0]?.body).get('Twiml')).toBe(TWIML);
    expect(await rest.endCall(LEG)).toBe(true);
    expect(f.requests.slice(1).map((r) => r.body)).toEqual([
      'Status=completed',
      'Status=canceled',
    ]);
  });

  it('refuses invalid input without calling Twilio', async () => {
    const f = fakeFetch(() => json({}));
    const rest = client(f.fetchImpl);
    expect(await rest.getCall('CA1')).toBeUndefined();
    expect(
      await rest.createCall({
        to: '4342483776',
        from: '+18723047712',
        twiml: TWIML,
        timeoutSeconds: 30,
      }),
    ).toBeUndefined();
    expect(await rest.updateCall(LEG, ' ')).toBe(false);
    expect(await rest.updateCall(LEG, 'x'.repeat(4001))).toBe(false);
    expect(await rest.endCall('nope')).toBe(false);
    expect(f.requests).toHaveLength(0);
  });

  it('never throws: HTTP errors, bad bodies, network failures and timeouts are undefined/false', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const failing = [
      fakeFetch(() => json({ message: 'nope' }, 500)),
      fakeFetch(() => new Response('not json', { status: 200 })),
      fakeFetch(() => {
        throw new TypeError('network');
      }),
    ];
    for (const f of failing) {
      const rest = client(f.fetchImpl);
      expect(await rest.getCall(CALL)).toBeUndefined();
      expect(await rest.updateCall(LEG, TWIML)).toBe(false);
      expect(await rest.endCall(LEG)).toBe(false);
    }
    const slow = fakeFetch(
      (r) =>
        new Promise<Response>((_, reject) => {
          void r;
          setTimeout(() => {
            const error = new Error('timeout');
            error.name = 'TimeoutError';
            reject(error);
          }, 20);
        }),
    );
    expect(await client(slow.fetchImpl, 10).getCall(CALL)).toBeUndefined();
  });

  it('logs no secrets, numbers or TwiML', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const f = fakeFetch(() => json({ message: 'nope' }, 500));
    await client(f.fetchImpl).createCall({
      to: '+14342483776',
      from: '+18723047712',
      twiml: TWIML,
      timeoutSeconds: 30,
    });
    const all = lines.join('\n');
    expect(all).toContain('twilio.rest_failed');
    for (const secret of ['secret', '+1434', '+1872', '<Response']) {
      expect(all).not.toContain(secret);
    }
  });
});

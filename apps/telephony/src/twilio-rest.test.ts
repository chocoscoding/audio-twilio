import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTwilioRest } from './twilio-rest.js';

const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const PARENT = `CA${'1'.repeat(32)}`;
const CHILD = `CA${'2'.repeat(32)}`;
const OTHER_CHILD = `CA${'3'.repeat(32)}`;
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

const child = (sid: string, status = 'in-progress') => ({
  sid,
  status,
  parent_call_sid: PARENT,
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

describe('createTwilioRest().releaseHumanLeg', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists in-progress children, then gives each the TwiML', async () => {
    const { fetchImpl, requests } = fakeFetch((request) =>
      request.method === 'GET'
        ? json({ calls: [child(CHILD)] })
        : json({ sid: CHILD, status: 'in-progress' }),
    );
    expect(await client(fetchImpl).releaseHumanLeg(PARENT, TWIML)).toBe(
      'released',
    );

    expect(requests).toHaveLength(2);
    const [list, update] = requests;
    const listUrl = new URL(list?.url ?? '');
    expect(`${listUrl.origin}${listUrl.pathname}`).toBe(`${BASE}.json`);
    expect(listUrl.searchParams.get('ParentCallSid')).toBe(PARENT);
    expect(listUrl.searchParams.get('Status')).toBe('in-progress');
    expect(list?.method).toBe('GET');

    expect(update?.url).toBe(`${BASE}/${CHILD}.json`);
    expect(update?.method).toBe('POST');
    expect(update?.headers['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(new URLSearchParams(update?.body).get('Twiml')).toBe(TWIML);

    const expected = `Basic ${Buffer.from('SKtest:secret').toString('base64')}`;
    expect(list?.headers['authorization']).toBe(expected);
    expect(update?.headers['authorization']).toBe(expected);
  });

  it('releases every in-progress child', async () => {
    const { fetchImpl, requests } = fakeFetch((request) =>
      request.method === 'GET'
        ? json({ calls: [child(CHILD), child(OTHER_CHILD)] })
        : json({}),
    );
    expect(await client(fetchImpl).releaseHumanLeg(PARENT, TWIML)).toBe(
      'released',
    );
    expect(
      requests.filter((r) => r.method === 'POST').map((r) => r.url),
    ).toEqual([`${BASE}/${CHILD}.json`, `${BASE}/${OTHER_CHILD}.json`]);
  });

  it("is 'none' when no child is in progress", async () => {
    const { fetchImpl, requests } = fakeFetch(() => json({ calls: [] }));
    expect(await client(fetchImpl).releaseHumanLeg(PARENT, TWIML)).toBe('none');
    expect(requests).toHaveLength(1);
  });

  it('never redirects the parent, a finished leg or a malformed SID', async () => {
    const { fetchImpl, requests } = fakeFetch(() =>
      json({
        calls: [
          { sid: PARENT, status: 'in-progress' },
          child(CHILD, 'completed'),
          child('CA../../Accounts', 'in-progress'),
          {
            sid: OTHER_CHILD,
            status: 'in-progress',
            parent_call_sid: `CA${'9'.repeat(32)}`,
          },
          'junk',
        ],
      }),
    );
    expect(await client(fetchImpl).releaseHumanLeg(PARENT, TWIML)).toBe('none');
    expect(requests).toHaveLength(1);
  });

  it("is 'error' when listing fails", async () => {
    for (const response of [
      () => json({ message: 'nope' }, 401),
      () => json({ message: 'nope' }, 500),
      () => json({ unexpected: true }),
      () => new Response('not json', { status: 200 }),
    ]) {
      const { fetchImpl } = fakeFetch(response);
      expect(await client(fetchImpl).releaseHumanLeg(PARENT, TWIML)).toBe(
        'error',
      );
    }
  });

  it("is 'error' when any update fails", async () => {
    const { fetchImpl } = fakeFetch((request) =>
      request.method === 'GET'
        ? json({ calls: [child(CHILD), child(OTHER_CHILD)] })
        : request.url.includes(OTHER_CHILD)
          ? json({ code: 21220 }, 400)
          : json({}),
    );
    expect(await client(fetchImpl).releaseHumanLeg(PARENT, TWIML)).toBe(
      'error',
    );
  });

  it("is 'error' on a network failure", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await client(fetchImpl).releaseHumanLeg(PARENT, TWIML)).toBe(
      'error',
    );
  });

  it("is 'error' on timeout, within the time limit", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Promise<Response>(() => undefined), // never answers on its own
    );
    // The fake ignores the signal, so wire it the way real fetch does.
    const abortable = (async (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) =>
      Promise.race([
        fetchImpl(input, init),
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
      ])) as typeof fetch;
    const started = Date.now();
    expect(await client(abortable, 30).releaseHumanLeg(PARENT, TWIML)).toBe(
      'error',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses invalid input without calling Twilio', async () => {
    const { fetchImpl, requests } = fakeFetch(() => json({ calls: [] }));
    const rest = client(fetchImpl);
    expect(await rest.releaseHumanLeg('CA123', TWIML)).toBe('error');
    expect(await rest.releaseHumanLeg(`CA${'G'.repeat(32)}`, TWIML)).toBe(
      'error',
    );
    expect(
      await rest.releaseHumanLeg(`${PARENT}&Status=completed`, TWIML),
    ).toBe('error');
    expect(await rest.releaseHumanLeg(PARENT, '  ')).toBe('error');
    expect(await rest.releaseHumanLeg(PARENT, 'x'.repeat(4_001))).toBe('error');
    expect(requests).toHaveLength(0);
  });

  it('rejects an invalid configuration at creation', () => {
    expect(() =>
      createTwilioRest({
        accountSid: 'AC123',
        apiKeySid: 'SK',
        apiKeySecret: 's',
      }),
    ).toThrow(/account SID/);
    expect(() =>
      createTwilioRest({
        accountSid: ACCOUNT_SID,
        apiKeySid: '',
        apiKeySecret: 's',
      }),
    ).toThrow(/API key/);
  });

  it('logs no secrets, TwiML or raw SIDs', async () => {
    const logged = vi.mocked(console.log);
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await client(fetchImpl).releaseHumanLeg(PARENT, TWIML);
    const output = logged.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).not.toContain(PARENT);
    expect(output).not.toContain('secret');
    expect(output).not.toContain('Hangup');
  });
});

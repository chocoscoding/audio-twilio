import { describe, expect, it } from 'vitest';

import { createAccessClient } from './access.js';

const auth = async () => ({ authorization: 'Bearer test-token' });

function stub(status: number, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('FourPoints phone API client', () => {
  it('sends the machine token and a User-Agent, and never the caller number', async () => {
    const s = stub(200, { outcome: 'INVALID' });
    const client = createAccessClient('https://api.test', auth, s.fetchImpl);
    expect(await client.resolve(10, '123456')).toEqual({ outcome: 'INVALID' });
    const { url, init } = s.calls[0]!;
    expect(url).toBe('https://api.test/internal/phone/resolve');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-token',
      'user-agent': 'fourpoints-telephony',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      orgNumber: 10,
      code: '123456',
    });
  });

  it('treats anything unexpected from resolve as a failure (the IVR then fails closed)', async () => {
    for (const s of [
      stub(500),
      stub(401),
      stub(200, { outcome: 'MAYBE' }),
      stub(200, { outcome: 'OK' }),
    ]) {
      await expect(
        createAccessClient('https://api.test', auth, s.fetchImpl).resolve(
          10,
          '123456',
        ),
      ).rejects.toThrow();
    }
  });

  it('maps usage answers to recorded / refused / error', async () => {
    const event = {
      event: 'end' as const,
      callSid: `CA${'a'.repeat(32)}`,
      leg: 1,
      organizationId: 'org',
      mode: 'AI' as const,
    };
    const answer = (status: number) =>
      createAccessClient(
        'https://api.test',
        auth,
        stub(status).fetchImpl,
      ).usage(event);
    expect(await answer(201)).toBe('recorded');
    expect(await answer(403)).toBe('refused');
    expect(await answer(404)).toBe('refused');
    expect(await answer(500)).toBe('error');
    const throwing = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect(
      await createAccessClient('https://api.test', auth, throwing).usage(event),
    ).toBe('error');
  });
});

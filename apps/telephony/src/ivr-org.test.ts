import { describe, expect, it } from 'vitest';

import type { WireLanguageCapability } from '@fourpoints/protocol';

import type {
  AccessClient,
  ResolveResult,
  UsageEvent,
  UsageResult,
} from './access.js';
import { loadConfig } from './config.js';
import { handleVoiceWebhook, type IvrContext } from './ivr.js';
import { buildMenu } from './languages.js';

/**
 * The organization line (new number): organization ID, then access code,
 * checked by FourPoints; the grant then rides in Twilio-signed URLs and each
 * AI or human leg is reported for usage. The current number is covered by
 * ivr.test.ts and must not change.
 */

const BASE = 'https://phone.example.com';
const config = loadConfig({
  PUBLIC_BASE_URL: BASE,
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'token',
  HUMAN_INTERPRETER_NUMBER: '+15550000001',
});
const voice = (
  languageId: string,
  displayName: string,
): WireLanguageCapability => ({
  languageId,
  displayName,
  input: { speech: true, text: true },
  output: { speech: true, text: true },
  capabilityTier: 'FULL_VOICE',
  validationStatus: 'TECHNICALLY_VALIDATED',
});
const menu = buildMenu(
  [voice('en-US', 'English (US)'), voice('es-US', 'Spanish (US)')],
  'en-US',
);

const ORG = '11111111-2222-4333-8444-555555555555';
const EMP = '66666666-7777-4888-8999-000000000000';
const CALL = `CA${'a'.repeat(32)}`;

function fakeAccess(
  result: ResolveResult | Error,
  usage: UsageResult = 'recorded',
) {
  const resolved: Array<[number, string]> = [];
  const events: UsageEvent[] = [];
  const access: AccessClient = {
    async resolve(orgNumber, code) {
      resolved.push([orgNumber, code]);
      if (result instanceof Error) throw result;
      return result;
    },
    async line() {
      throw new Error('not a company number');
    },
    async usage(event) {
      events.push(event);
      return usage;
    },
  };
  return { access, resolved, events };
}

const OK: ResolveResult = {
  outcome: 'OK',
  organizationId: ORG,
  employeeId: EMP,
  aiAllowed: true,
  humanAllowed: true,
  minutesRemaining: 42,
};

async function hook(
  path: string,
  query: Record<string, string>,
  body: Record<string, string>,
  overrides: Partial<IvrContext> = {},
): Promise<string> {
  return (
    (await handleVoiceWebhook(
      path,
      new URLSearchParams(query),
      new URLSearchParams({ CallSid: CALL, ...body }),
      { config, menu, aiAvailable: true, ...overrides },
    )) ?? 'NOT FOUND'
  );
}

/** The query string of the first action URL in some TwiML, as an object. */
const firstAction = (twiml: string) => {
  const m = /action="([^"]+)"/.exec(twiml);
  const href = (m?.[1] ?? '').replace(/&amp;/g, '&');
  return Object.fromEntries(new URL(href).searchParams);
};

const GRANT = {
  org: ORG,
  emp: EMP,
  ai: '1',
  hu: '1',
  min: '42',
  leg: '0',
};

describe('organization line', () => {
  it('asks for the organization ID first, then the code', async () => {
    const first = await hook('/voice/org/incoming', {}, {});
    expect(first).toContain(
      'Welcome to FourPoints interpretation. Please enter your organization ID, then press pound.',
    );
    expect(first).toContain(`action="${BASE}/voice/org/number?attempt=1"`);
    const second = await hook(
      '/voice/org/number',
      { attempt: '1' },
      { Digits: '010' },
    );
    expect(second).toContain(
      'Please enter your access code, then press pound.',
    );
    // Both entries end on pound (no digit count), so the caller's pound is
    // used up there and never reaches the next menu.
    expect(first).toContain('finishOnKey="#"');
    expect(first).not.toContain('numDigits');
    expect(second).toContain('finishOnKey="#"');
    expect(second).not.toContain('numDigits');
    // Time to think: 12 s before the first digit and between digits.
    expect(first).toContain('finishOnKey="#" timeout="12"');
    expect(second).toContain('finishOnKey="#" timeout="12"');
    expect(second).toContain(
      `action="${BASE}/voice/org/code?n=10&amp;attempt=1"`,
    );
  });

  it('re-asks for an unreadable organization ID, then says goodbye', async () => {
    expect(
      await hook('/voice/org/number', { attempt: '1' }, { Digits: '5' }),
    ).toContain('Sorry, that is not a valid organization ID.');
    expect(
      await hook('/voice/org/number', { attempt: '3' }, { Digits: '' }),
    ).toContain('<Hangup/>');
  });

  it('checks the code with FourPoints and carries the grant, never the code', async () => {
    const f = fakeAccess(OK);
    const twiml = await hook(
      '/voice/org/code',
      { n: '10', attempt: '1' },
      { Digits: '123456' },
      { access: f.access },
    );
    expect(f.resolved).toEqual([[10, '123456']]);
    expect(twiml).toContain(
      'Thank you. For an AI interpreter, press 1. For a human interpreter, press 2.',
    );
    expect(firstAction(twiml)).toMatchObject(GRANT);
    expect(twiml).not.toContain('123456');
  });

  it('a wrong code re-asks from the organization ID, three times at most', async () => {
    const f = fakeAccess({ outcome: 'INVALID' });
    const retry = await hook(
      '/voice/org/code',
      { n: '10', attempt: '1' },
      { Digits: '000000' },
      { access: f.access },
    );
    expect(retry).toContain(
      'was not recognized. Please enter your organization ID',
    );
    expect(firstAction(retry)).toEqual({ attempt: '2' });
    const last = await hook(
      '/voice/org/code',
      { n: '10', attempt: '3' },
      { Digits: '000000' },
      { access: f.access },
    );
    expect(last).toContain('<Hangup/>');
  });

  it.each<[ResolveResult['outcome'], string]>([
    ['NOT_ACTIVE', 'not available for your organization right now'],
    ['NO_PHONE_ACCESS', 'not available for your organization right now'],
    ['QUOTA_EXHAUSTED', 'used all of its interpretation minutes'],
  ])('%s ends the call politely', async (outcome, text) => {
    const twiml = await hook(
      '/voice/org/code',
      { n: '10', attempt: '1' },
      { Digits: '123456' },
      { access: fakeAccess({ outcome } as ResolveResult).access },
    );
    expect(twiml).toContain(text);
    expect(twiml).toContain('<Hangup/>');
  });

  it('fails closed when FourPoints cannot be reached, or is not configured', async () => {
    const down = await hook(
      '/voice/org/code',
      { n: '10', attempt: '1' },
      { Digits: '123456' },
      { access: fakeAccess(new Error('timeout')).access },
    );
    expect(down).toContain('cannot check your access code right now');
    expect(down).not.toContain('<Gather');
    const none = await hook(
      '/voice/org/code',
      { n: '10', attempt: '1' },
      { Digits: '123456' },
    );
    expect(none).toContain('This line is not available right now.');
  });

  it('ignores any grant in the URL until the code is checked', async () => {
    const f = fakeAccess({ outcome: 'INVALID' });
    const twiml = await hook(
      '/voice/org/code',
      { n: '10', attempt: '1', ...GRANT },
      { Digits: '000000' },
      { access: f.access },
    );
    expect(firstAction(twiml)).toEqual({ attempt: '2' });
  });

  it('the mode menu ignores pound and waits; no key press is said as such', async () => {
    const menuTwiml = await hook(
      '/voice/org/code',
      { n: '10', attempt: '1' },
      { Digits: '123456' },
      { access: fakeAccess(OK).access },
    );
    expect(menuTwiml).toContain('finishOnKey=""');
    expect(menuTwiml).toContain('timeout="10"');
    const empty = await hook(
      '/voice/mode',
      { ...GRANT, attempt: '1' },
      {
        Digits: '',
      },
    );
    expect(empty).toContain('You have not made a choice yet.');
    expect(empty).not.toContain('not a valid choice');
    const wrong = await hook(
      '/voice/mode',
      { ...GRANT, attempt: '1' },
      {
        Digits: '7',
      },
    );
    expect(wrong).toContain('Sorry, that was not a valid choice.');
  });

  it('never picks a human for the caller: after the last try it says goodbye', async () => {
    for (const path of ['/voice/mode', '/voice/select']) {
      const twiml = await hook(
        path,
        { ...GRANT, mode: 'ai', v: menu.version, attempt: '3' },
        {},
      );
      expect(twiml).toContain('We did not receive a choice.');
      expect(twiml).toContain('<Hangup/>');
      expect(twiml).not.toContain('<Dial');
    }
  });

  it('with AI only, goes straight to the language menu', async () => {
    const twiml = await hook(
      '/voice/org/code',
      { n: '10', attempt: '1' },
      { Digits: '123456' },
      { access: fakeAccess({ ...OK, humanAllowed: false }).access },
    );
    expect(twiml).toContain('Please choose a language.');
    expect(firstAction(twiml)).toMatchObject({ mode: 'ai', hu: '0' });
  });

  it('reports an AI leg when connecting, and its end', async () => {
    const f = fakeAccess(OK);
    const twiml = await hook(
      '/voice/select',
      { ...GRANT, mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1' },
      { access: f.access },
    );
    expect(twiml).toContain('<Connect');
    expect(f.events).toEqual([
      {
        event: 'start',
        callSid: CALL,
        leg: 1,
        organizationId: ORG,
        employeeId: EMP,
        mode: 'AI',
        languageId: 'es-US',
        lineKind: 'SHARED',
        codeKind: 'NONE',
      },
    ]);
    // The organization never goes into the media stream.
    expect(twiml).not.toMatch(/<Parameter name="(org|organization)/);
    const ended = firstAction(twiml);
    expect(ended).toMatchObject({ org: ORG, leg: '1' });

    await hook(
      '/voice/ai-ended',
      ended,
      { CallStatus: 'completed' },
      {
        access: f.access,
      },
    );
    expect(f.events[1]).toEqual({
      event: 'end',
      callSid: CALL,
      leg: 1,
      organizationId: ORG,
      mode: 'AI',
    });
  });

  it('accepts an 8-digit list code and reports it, with the two numbers', async () => {
    const GRANT_ID = '99999999-8888-4777-8666-555555555555';
    const f = fakeAccess({ ...OK, employeeId: null, codeGrantId: GRANT_ID });
    const menuTwiml = await hook(
      '/voice/org/code',
      { n: '10' },
      { Digits: '12345678' },
      { access: f.access },
    );
    expect(f.resolved).toEqual([[10, '12345678']]);
    expect(firstAction(menuTwiml)).toMatchObject({ cg: GRANT_ID, ck: 'GRANT' });
    await hook(
      '/voice/select',
      {
        ...GRANT,
        cg: GRANT_ID,
        ck: 'GRANT',
        mode: 'ai',
        v: menu.version,
        attempt: '1',
      },
      { Digits: '1', From: '+15550100123', To: '+18723047712' },
      { access: f.access },
    );
    expect(f.events[0]).toMatchObject({
      event: 'start',
      codeGrantId: GRANT_ID,
      codeKind: 'GRANT',
      lineKind: 'SHARED',
      from: '+15550100123',
      to: '+18723047712',
    });
  });

  it.each(['12345', '1234567', '123456789'])(
    'refuses %s without asking FourPoints',
    async (Digits) => {
      const f = fakeAccess(OK);
      await hook(
        '/voice/org/code',
        { n: '10' },
        { Digits },
        { access: f.access },
      );
      expect(f.resolved).toEqual([]);
    },
  );

  it('sends no caller number when it is withheld', async () => {
    const f = fakeAccess(OK);
    await hook(
      '/voice/select',
      { ...GRANT, mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1', From: 'anonymous', To: '+18723047712' },
      { access: f.access },
    );
    expect(f.events[0]).not.toHaveProperty('from');
    expect(f.events[0]).toMatchObject({ to: '+18723047712' });
  });

  it('never logs either number', async () => {
    const logged: unknown[] = [];
    await hook(
      '/voice/select',
      { ...GRANT, mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1', From: '+15550100123', To: '+18723047712' },
      {
        access: fakeAccess(OK).access,
        log: (...args) => logged.push(args),
      },
    );
    expect(JSON.stringify(logged)).not.toMatch(/5550100123|8723047712/);
  });

  it('puts the time limit on an AI call and says goodbye when it is reached', async () => {
    const f = fakeAccess(OK);
    const twiml = await hook(
      '/voice/select',
      { ...GRANT, mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1' },
      { access: f.access },
    );
    expect(twiml).toContain('<Parameter name="limit" value="');
    const ended = await hook(
      '/voice/ai-ended',
      { ...GRANT, leg: '1', lang: 'es-US' },
      { CallStatus: 'in-progress' },
      { access: f.access, aiTimedOut: () => true },
    );
    expect(ended).toContain(
      'Your interpretation minutes for this call have ended.',
    );
    expect(ended).toContain('<Hangup/>');
    expect(ended).not.toContain('<Dial');
  });

  it('ends the leg from the stream status too, once the stream stops', async () => {
    const f = fakeAccess(OK);
    await hook(
      '/voice/stream-status',
      { ...GRANT, leg: '2' },
      { StreamEvent: 'stream-started' },
      { access: f.access },
    );
    expect(f.events).toEqual([]);
    await hook(
      '/voice/stream-status',
      { ...GRANT, leg: '2' },
      { StreamEvent: 'stream-stopped' },
      { access: f.access },
    );
    expect(f.events).toEqual([
      {
        event: 'end',
        callSid: CALL,
        leg: 2,
        organizationId: ORG,
        mode: 'AI',
      },
    ]);
  });

  it('a relayed human stream ends as a human leg', async () => {
    const f = fakeAccess(OK);
    await hook(
      '/voice/stream-status',
      { ...GRANT, leg: '2', end: 'HUMAN' },
      { StreamEvent: 'stream-error' },
      { access: f.access },
    );
    expect(f.events[0]).toMatchObject({ event: 'end', mode: 'HUMAN' });
  });

  it("reports Twilio's duration of an answered human call", async () => {
    const f = fakeAccess(OK);
    await hook(
      '/voice/human-result',
      { ...GRANT, leg: '2' },
      { DialCallStatus: 'completed', DialCallDuration: '125' },
      { access: f.access },
    );
    expect(f.events[0]).toMatchObject({ mode: 'HUMAN', durationSeconds: 125 });
  });

  it.each(['no-answer', 'busy', 'failed', 'canceled'])(
    'a human call that was never answered bills no ringing (%s)',
    async (status) => {
      const f = fakeAccess(OK);
      await hook(
        '/voice/human-result',
        { ...GRANT, leg: '2' },
        { DialCallStatus: status },
        { access: f.access },
      );
      expect(f.events[0]).toMatchObject({ durationSeconds: 0 });
    },
  );

  it('repeats a failed end report in the background until it lands', async () => {
    const f = fakeAccess(OK, 'error');
    const logged: string[] = [];
    await hook(
      '/voice/ai-ended',
      { ...GRANT, leg: '1' },
      { CallStatus: 'completed' },
      {
        access: f.access,
        log: (e) => logged.push(e),
        usageRetryDelaysMs: [1, 1, 1],
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.events).toHaveLength(4);
    expect(logged).toEqual(['usage.end_failed', 'usage.end_lost']);
  });

  it('caps a human call at the minutes left and counts it as its own leg', async () => {
    const f = fakeAccess(OK);
    const twiml = await hook(
      '/voice/select',
      { ...GRANT, leg: '1', mode: 'human', v: menu.version, attempt: '1' },
      { Digits: '1' },
      { access: f.access },
    );
    expect(twiml).toContain('timeLimit="2520"');
    expect(f.events[0]).toMatchObject({
      event: 'start',
      mode: 'HUMAN',
      leg: 2,
    });
  });

  it('does not connect when FourPoints refuses the leg (organization paused)', async () => {
    const twiml = await hook(
      '/voice/select',
      { ...GRANT, mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1' },
      { access: fakeAccess(OK, 'refused').access },
    );
    expect(twiml).not.toContain('<Connect');
    expect(twiml).toContain('not available for your organization');
  });

  it('still connects if the usage report fails (logged, not refused)', async () => {
    const logged: string[] = [];
    const twiml = await hook(
      '/voice/select',
      { ...GRANT, mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1' },
      { access: fakeAccess(OK, 'error').access, log: (e) => logged.push(e) },
    );
    expect(twiml).toContain('<Connect');
    expect(logged).toContain('usage.start_failed');
  });

  it('never dials a human when the organization has no human interpretation', async () => {
    const f = fakeAccess(OK);
    const noHuman = { ...GRANT, hu: '0', leg: '1', lang: 'es-US' };
    const twiml = await hook(
      '/voice/ai-ended',
      noHuman,
      { CallStatus: 'in-progress' },
      { access: f.access },
    );
    expect(twiml).not.toContain('<Dial');
    expect(twiml).toContain('not included for your organization');
  });

  it('does not offer AI after a failed human call when AI is not included', async () => {
    const twiml = await hook(
      '/voice/human-result',
      { ...GRANT, ai: '0', leg: '1', lang: 'es-US' },
      { DialCallStatus: 'no-answer' },
      { access: fakeAccess(OK).access },
    );
    expect(twiml).not.toContain('To use the AI interpreter instead');
  });

  it('the current number reports nothing and is unchanged', async () => {
    const f = fakeAccess(OK);
    const twiml = await hook(
      '/voice/select',
      { mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1' },
      { access: f.access },
    );
    expect(twiml).toContain('<Connect');
    expect(f.events).toEqual([]);
    expect(firstAction(twiml)).toEqual({ lang: 'es-US' });
  });
});

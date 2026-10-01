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
    expect(second).toContain('Please enter your six digit access code.');
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

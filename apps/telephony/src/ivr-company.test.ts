import { describe, expect, it } from 'vitest';

import type { WireLanguageCapability } from '@fourpoints/protocol';

import type {
  AccessClient,
  LineResult,
  ResolveResult,
  UsageEvent,
} from './access.js';
import { StaticCompanySource, type Company } from './companies.js';
import { loadConfig } from './config.js';
import { handleVoiceWebhook, MAX_SWITCHES, type IvrContext } from './ivr.js';
import { buildMenu } from './languages.js';

/**
 * Companies with a number of their own (companies.ts), their own
 * interpreter line (OPI), and ### between AI and human.
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
const OTHER_ORG = '99999999-2222-4333-8444-555555555555';
const CALL = `CA${'a'.repeat(32)}`;
const TWILIO_NUMBER = '+15557654321';
const OPI = '+18885550000';

const ACME: Company = {
  orgNumber: 123,
  organizationId: ORG,
  companyName: 'Acme Health',
  lines: [{ twilioNumber: TWILIO_NUMBER }],
  humanNumber: OPI,
};
const companies = StaticCompanySource.from([ACME]);

const GRANTED = {
  outcome: 'OK',
  organizationId: ORG,
  employeeId: null,
  aiAllowed: true,
  humanAllowed: true,
  minutesRemaining: 42,
} as const;

function fakeAccess(line: LineResult | Error, resolve?: ResolveResult) {
  const lines: Array<[number, string]> = [];
  const events: UsageEvent[] = [];
  const access: AccessClient = {
    async resolve() {
      if (resolve === undefined) throw new Error('unexpected resolve');
      return resolve;
    },
    async line(orgNumber, organizationId) {
      lines.push([orgNumber, organizationId]);
      if (line instanceof Error) throw line;
      return line;
    },
    async usage(event) {
      events.push(event);
      return 'recorded';
    },
  };
  return { access, lines, events };
}

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
      { config, menu, aiAvailable: true, companies, ...overrides },
    )) ?? 'NOT FOUND'
  );
}

const actionOf = (twiml: string, route: string) => {
  const m = new RegExp(`"(${BASE}${route}[^"]*)"`).exec(twiml);
  const href = (m?.[1] ?? '').replace(/&amp;/g, '&');
  return href === '' ? {} : Object.fromEntries(new URL(href).searchParams);
};

/** A company call's state after access, as it travels in signed URLs. */
const ACME_GRANT = {
  org: ORG,
  ai: '1',
  hu: '1',
  min: '42',
  leg: '0',
  co: '123',
};

describe('a company number', () => {
  it('welcomes with the company name and goes straight in without a code', async () => {
    const f = fakeAccess(GRANTED);
    const twiml = await hook(
      '/voice/org/incoming',
      {},
      { To: TWILIO_NUMBER },
      { access: f.access },
    );
    expect(f.lines).toEqual([[123, ORG]]);
    expect(twiml).toContain(
      'Welcome to Acme Health. For an AI interpreter, press 1. For a human interpreter, press 2.',
    );
    expect(twiml).not.toContain('FourPoints');
    expect(twiml).not.toContain('organization ID');
    expect(actionOf(twiml, '/voice/mode')).toMatchObject(ACME_GRANT);
  });

  it('asks only for the access code when the organization has one', async () => {
    const twiml = await hook(
      '/voice/org/incoming',
      {},
      { To: TWILIO_NUMBER },
      { access: fakeAccess({ outcome: 'CODE_REQUIRED' }).access },
    );
    expect(twiml).toContain(
      'Welcome to Acme Health. Please enter your six digit access code, then press pound.',
    );
    expect(twiml).not.toContain('organization ID');
    expect(actionOf(twiml, '/voice/org/code')).toEqual({
      n: '123',
      attempt: '1',
      dl: '1',
    });
  });

  it('re-asks for the code, not the organization ID, after a wrong code', async () => {
    const f = fakeAccess(GRANTED, { outcome: 'INVALID' });
    const retry = await hook(
      '/voice/org/code',
      { n: '123', attempt: '1', dl: '1' },
      { Digits: '000000' },
      { access: f.access },
    );
    expect(retry).toContain(
      'Sorry, that access code was not recognized. Please enter your six digit access code',
    );
    expect(actionOf(retry, '/voice/org/code')).toEqual({
      n: '123',
      attempt: '2',
      dl: '1',
    });
    const last = await hook(
      '/voice/org/code',
      { n: '123', attempt: '3', dl: '1' },
      { Digits: '000000' },
      { access: f.access },
    );
    expect(last).toContain('<Hangup/>');
  });

  it('after a valid code, keeps the company for its own interpreters', async () => {
    const f = fakeAccess(GRANTED, { ...GRANTED, employeeId: null });
    const twiml = await hook(
      '/voice/org/code',
      { n: '123', attempt: '1', dl: '1' },
      { Digits: '123456' },
      { access: f.access },
    );
    expect(twiml).toContain('Thank you. For an AI interpreter, press 1.');
    expect(actionOf(twiml, '/voice/mode')).toMatchObject(ACME_GRANT);
  });

  it('refuses a code that resolves to another organization on a company number', async () => {
    const twiml = await hook(
      '/voice/org/code',
      { n: '123', attempt: '1', dl: '1' },
      { Digits: '123456' },
      {
        access: fakeAccess(GRANTED, { ...GRANTED, organizationId: OTHER_ORG })
          .access,
      },
    );
    expect(twiml).toContain('This line is not available right now. Goodbye.');
    expect(twiml).toContain('<Hangup/>');
  });

  it('fails closed when FourPoints refuses, fails, or answers for another organization', async () => {
    for (const line of [
      { outcome: 'INVALID' } as const,
      new Error('timeout'),
      { ...GRANTED, organizationId: OTHER_ORG },
    ]) {
      const twiml = await hook(
        '/voice/org/incoming',
        {},
        { To: TWILIO_NUMBER },
        { access: fakeAccess(line).access },
      );
      expect(twiml).toContain('This line is not available right now.');
      expect(twiml).toContain('<Hangup/>');
    }
    expect(
      await hook(
        '/voice/org/incoming',
        {},
        { To: TWILIO_NUMBER },
        { access: fakeAccess({ outcome: 'QUOTA_EXHAUSTED' }).access },
      ),
    ).toContain('used all of its interpretation minutes');
  });

  it('leaves calls on other numbers on the shared organization line', async () => {
    const f = fakeAccess(GRANTED);
    const twiml = await hook(
      '/voice/org/incoming',
      {},
      { To: '+15550009999' },
      { access: f.access },
    );
    expect(f.lines).toEqual([]);
    expect(twiml).toContain(
      'Welcome to FourPoints interpretation. Please enter your organization ID',
    );
  });

  it('plays the welcome to an AI-only company before the language menu', async () => {
    const twiml = await hook(
      '/voice/org/incoming',
      {},
      { To: TWILIO_NUMBER },
      { access: fakeAccess({ ...GRANTED, humanAllowed: false }).access },
    );
    expect(twiml).toContain(
      'Welcome to Acme Health. Please choose a language.',
    );
  });
});

describe('a company welcome', () => {
  it("uses the company's own greeting text when it has one", async () => {
    const own = StaticCompanySource.from([
      { ...ACME, welcome: 'Thank you for calling Acme Health.' },
    ]);
    const twiml = await hook(
      '/voice/org/incoming',
      {},
      { To: TWILIO_NUMBER },
      { access: fakeAccess(GRANTED).access, companies: own },
    );
    expect(twiml).toContain(
      'Thank you for calling Acme Health. For an AI interpreter, press 1.',
    );
    expect(twiml).not.toContain('Welcome to');
    expect(() => StaticCompanySource.from([{ ...ACME, welcome: ' ' }])).toThrow(
      'welcome is empty',
    );
  });
});

describe('a company interpreter line (OPI)', () => {
  it('offers the AI, then the language menu, when the company line does not answer', async () => {
    const f = fakeAccess(GRANTED);
    const twiml = await hook(
      '/voice/human-result',
      { ...ACME_GRANT, leg: '1' },
      { DialCallStatus: 'no-answer' },
      { access: f.access },
    );
    expect(twiml).toContain('Sorry, no interpreter is available right now.');
    expect(twiml).toContain('To use the AI interpreter instead, press 1.');
    expect(actionOf(twiml, '/voice/ai')).toMatchObject({
      ...ACME_GRANT,
      leg: '1',
    });
    const menuTwiml = await hook(
      '/voice/ai',
      { ...ACME_GRANT, leg: '1' },
      { Digits: '1' },
      { access: f.access },
    );
    expect(menuTwiml).toContain(
      'Please choose a language. For Spanish, press 1.',
    );
    // No key: goodbye.
    expect(twiml).toMatch(/<\/Gather>.*Goodbye\..*<Hangup\/>/);
  });

  it('says goodbye when the company line does not answer and the company has no AI', async () => {
    const twiml = await hook(
      '/voice/human-result',
      { ...ACME_GRANT, ai: '0', leg: '1' },
      { DialCallStatus: 'busy' },
      { access: fakeAccess(GRANTED).access },
    );
    expect(twiml).toContain(
      'Sorry, no interpreter is available right now. Please try again later. Goodbye.',
    );
    expect(twiml).not.toContain('AI interpreter instead');
  });

  it('rings the company line with no language menu and no press-1 screening', async () => {
    const twiml = await hook(
      '/voice/mode',
      { ...ACME_GRANT, attempt: '1' },
      { Digits: '2' },
      { access: fakeAccess(GRANTED).access },
    );
    expect(twiml).toContain(
      'Connecting you to a human interpreter. Please hold.',
    );
    expect(twiml).toContain(`<Number>${OPI}</Number>`);
    expect(twiml).not.toContain('/voice/whisper');
    expect(twiml).not.toContain('choose a language');
  });

  it('goes straight to the company line for a human-only company', async () => {
    const twiml = await hook(
      '/voice/org/incoming',
      {},
      { To: TWILIO_NUMBER },
      { access: fakeAccess({ ...GRANTED, aiAllowed: false }).access },
    );
    expect(twiml).toMatch(
      /Welcome to Acme Health\.<\/Say><Say[^>]*>Connecting you to a human interpreter\. Please hold\./,
    );
    expect(twiml).toContain(`<Number>${OPI}</Number>`);
  });

  it('uses the FourPoints interpreters for calls without a listed company', async () => {
    const twiml = await hook(
      '/voice/select',
      { mode: 'human', v: menu.version, attempt: '1' },
      { Digits: '1' },
    );
    expect(twiml).toContain('<Number url=');
    expect(twiml).toContain('+15550000001');
  });
});

describe('### between AI and human', () => {
  const spanish = { ...ACME_GRANT, lang: 'es-US' };

  it('lets the AI stream hand over to a human (yes/no only, never the organization)', async () => {
    const twiml = await hook(
      '/voice/select',
      { ...ACME_GRANT, mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1' },
      { access: fakeAccess(GRANTED).access },
    );
    expect(twiml).toContain('<Parameter name="transfer" value="1"/>');
    expect(twiml).not.toMatch(/<Parameter name="(org|organization|co)/);
  });

  it('does not offer ### to a human when the company has no human', async () => {
    const twiml = await hook(
      '/voice/select',
      { ...ACME_GRANT, hu: '0', mode: 'ai', v: menu.version, attempt: '1' },
      { Digits: '1' },
      { access: fakeAccess(GRANTED).access },
    );
    expect(twiml).not.toContain('name="transfer"');
  });

  it('AI → human: dials the company line without saying the AI is unavailable', async () => {
    const twiml = await hook(
      '/voice/ai-ended',
      spanish,
      { CallStatus: 'in-progress' },
      { access: fakeAccess(GRANTED).access },
    );
    expect(twiml).not.toContain('unavailable');
    expect(twiml).toContain(
      'Connecting you to a human interpreter. Please hold.',
    );
    expect(twiml).toContain(`<Number>${OPI}</Number>`);
    expect(actionOf(twiml, '/voice/human-result')).toMatchObject({ sw: '1' });
  });

  it('starts a caller-side watch stream on human calls when the switch to AI is possible', async () => {
    const twiml = await hook(
      '/voice/ai-ended',
      spanish,
      { CallStatus: 'in-progress' },
      { access: fakeAccess(GRANTED).access, humanToAi: true },
    );
    expect(twiml).toContain(
      `<Start><Stream name="watch" url="wss://phone.example.com/watch" track="inbound_track"/></Start>`,
    );
    expect(actionOf(twiml, '/voice/human-result')).toMatchObject({ wt: '1' });
    // Without Twilio REST, or for a human-only company, there is none.
    for (const overrides of [
      { humanToAi: false },
      { humanToAi: true, query: { ai: '0' } },
    ] as const) {
      const other = await hook(
        '/voice/ai-ended',
        { ...spanish, ...('query' in overrides ? overrides.query : {}) },
        { CallStatus: 'in-progress' },
        {
          access: fakeAccess(GRANTED).access,
          humanToAi: overrides.humanToAi,
        },
      );
      expect(other).not.toContain('<Start>');
    }
  });

  it('human → AI: a released interpreter (no DialCallDuration) reads the language menu', async () => {
    const f = fakeAccess(GRANTED);
    const twiml = await hook(
      '/voice/human-result',
      { ...ACME_GRANT, leg: '1', wt: '1' },
      { DialCallStatus: 'completed' },
      { access: f.access, humanToAi: true },
    );
    expect(f.events).toMatchObject([{ event: 'end', mode: 'HUMAN' }]);
    expect(twiml).toContain('<Stop><Stream name="watch"/></Stop>');
    expect(twiml).toContain(
      'Switching you to the AI interpreter. Please choose a language. For Spanish, press 1.',
    );
    expect(twiml).not.toContain('Welcome');
    expect(twiml).not.toContain('For an AI interpreter, press 1');
    expect(actionOf(twiml, '/voice/select')).toMatchObject({
      mode: 'ai',
      sw: '1',
    });
  });

  it('an interpreter hanging up normally still ends the call', async () => {
    const twiml = await hook(
      '/voice/human-result',
      { ...ACME_GRANT, leg: '1', wt: '1' },
      { DialCallStatus: 'completed', DialCallDuration: '300' },
      { access: fakeAccess(GRANTED).access, humanToAi: true },
    );
    expect(twiml).toContain('<Stop><Stream name="watch"/></Stop>');
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('choose a language');
  });

  it(`stops offering ### after ${MAX_SWITCHES} switches`, async () => {
    const twiml = await hook(
      '/voice/ai-ended',
      { ...spanish, sw: String(MAX_SWITCHES - 1) },
      { CallStatus: 'in-progress' },
      { access: fakeAccess(GRANTED).access, humanToAi: true },
    );
    expect(actionOf(twiml, '/voice/human-result')).toMatchObject({
      sw: String(MAX_SWITCHES),
    });
    expect(twiml).not.toContain('<Start>');
    const ai = await hook(
      '/voice/select',
      {
        ...ACME_GRANT,
        sw: String(MAX_SWITCHES),
        mode: 'ai',
        v: menu.version,
        attempt: '1',
      },
      { Digits: '1' },
      { access: fakeAccess(GRANTED).access },
    );
    expect(ai).not.toContain('name="transfer"');
  });
});

describe('the company list', () => {
  it('refuses a number listed twice, a bad number, or a bad organization ID', () => {
    expect(() =>
      StaticCompanySource.from([ACME, { ...ACME, orgNumber: 124 }]),
    ).toThrow('listed twice');
    expect(() =>
      StaticCompanySource.from([
        {
          ...ACME,
          lines: [{ twilioNumber: '5557654321' }],
        },
      ]),
    ).toThrow('+15551234567 format');
    expect(() =>
      StaticCompanySource.from([{ ...ACME, organizationId: 'acme' }]),
    ).toThrow('UUID');
    expect(() =>
      StaticCompanySource.from([
        {
          ...ACME,
          lines: [{ twilioNumber: '+15557654321', publicNumber: '800-555' }],
        },
      ]),
    ).toThrow('+15551234567 format');
    // A forwarded number's own number is optional and never matched.
    const forwarded = StaticCompanySource.from([
      {
        ...ACME,
        lines: [{ twilioNumber: '+15557654321', publicNumber: '+18005551234' }],
      },
    ]);
    expect(forwarded.byTwilioNumber('+15557654321')?.orgNumber).toBe(123);
    expect(forwarded.byTwilioNumber('+18005551234')).toBeUndefined();
  });
});

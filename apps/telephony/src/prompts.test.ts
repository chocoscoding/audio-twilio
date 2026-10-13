import { describe, expect, it } from 'vitest';

import type { WireLanguageCapability } from '@fourpoints/protocol';

import type { AccessClient, ResolveResult } from './access.js';
import { BUNDLED_PROMPTS_DIR, loadConfig } from './config.js';
import { handleVoiceWebhook, type IvrContext } from './ivr.js';
import { buildMenu, EMPTY_MENU } from './languages.js';
import { PromptLibrary, mulawWav, parseMulawWav } from './prompts.js';

const BASE = 'https://phone.example.com';
const config = loadConfig({
  PUBLIC_BASE_URL: BASE,
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'token',
  HUMAN_INTERPRETER_NUMBERS: JSON.stringify({ default: ['+15550000001'] }),
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

/** The FourPoints phone languages, registry order (apps/realtime). */
const menu = buildMenu(
  [
    voice('en-US', 'English (US)'),
    voice('es-US', 'Spanish (US)'),
    voice('fr-FR', 'French (France)'),
    voice('de-DE', 'German (Germany)'),
    voice('it-IT', 'Italian (Italy)'),
    voice('pt-BR', 'Portuguese (Brazil)'),
    voice('hi-IN', 'Hindi (India)'),
    voice('ja-JP', 'Japanese (Japan)'),
    voice('ko-KR', 'Korean (South Korea)'),
    voice('zh-CN', 'Mandarin Chinese (Simplified)'),
    voice('ar-AE', 'Arabic (Gulf)'),
  ],
  'en-US',
);

const hook = async (
  path: string,
  query: Record<string, string>,
  body: Record<string, string>,
  ctx: Partial<IvrContext>,
) =>
  (await handleVoiceWebhook(
    path,
    new URLSearchParams(query),
    new URLSearchParams(body),
    { config, menu, aiAvailable: true, ...ctx },
  )) ?? 'NOT FOUND';

const says = (twiml: string) =>
  [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1] ?? '');

describe('prompt files', () => {
  it('reads μ-law WAVs and refuses anything else', () => {
    const samples = Uint8Array.from([1, 2, 3, 255]);
    expect([...parseMulawWav(mulawWav(samples))]).toEqual([1, 2, 3, 255]);
    const pcm = mulawWav(samples);
    pcm.writeUInt16LE(1, 20); // PCM, not μ-law
    expect(() => parseMulawWav(pcm)).toThrow('not 8 kHz mono μ-law');
    expect(() => parseMulawWav(Buffer.from('nope'))).toThrow('not a WAV file');
  });

  it('matches a clip only when it says what the code would say', () => {
    const library = PromptLibrary.of([
      { id: 'a', text: 'Press 1.', mulaw: new Uint8Array(8) },
      { id: 'g', text: 'Hello. Hola.', mulaw: new Uint8Array(8) },
    ]);
    expect(library.match('a', 'Press 1.')?.id).toBe('a');
    expect(library.match('a', 'Press 0.')).toBeUndefined();
    expect(library.match('g', 'Hello.')?.id).toBe('g'); // then the translation
    expect(library.match('g', 'Hell')).toBeUndefined();
    expect(library.match('x', 'Press 1.')).toBeUndefined();
  });

  it('loads every approved clip in ivr-audio/final', () => {
    const skipped: string[] = [];
    const library = PromptLibrary.load(BUNDLED_PROMPTS_DIR, (id) =>
      skipped.push(id),
    );
    expect(skipped).toEqual([]);
    expect(library.size).toBeGreaterThanOrEqual(68);
    expect(library.clip('hold-music')?.mulaw.length).toBeGreaterThan(8000 * 20);
  });
});

describe('IVR with recorded prompts', () => {
  const library = PromptLibrary.of([
    {
      id: 'welcome',
      text: 'Welcome to FourPoints interpretation.',
      mulaw: new Uint8Array(8),
    },
    {
      id: 'mode-menu',
      text: 'For an AI interpreter, press 1. For a human interpreter, press 2.',
      mulaw: new Uint8Array(8),
    },
    {
      id: 'ai-connected-fr-fr',
      text: 'You are connected to the French AI Interpreter. Please speak one person at a time. Press star when you are done. Vous êtes connecté.',
      mulaw: new Uint8Array(8),
    },
    // Recorded for an older menu order: must not be played.
    {
      id: 'language-option-es-us',
      text: 'For Spanish, press 9.',
      mulaw: new Uint8Array(8),
    },
  ]);

  it('plays matching clips, cache-safe by content hash', async () => {
    const twiml = await hook('/voice/incoming', {}, {}, { prompts: library });
    const welcome = library.clip('welcome')?.version ?? '';
    expect(twiml).toContain(
      `<Play>${BASE}/prompts/welcome.wav?v=${welcome}</Play>`,
    );
    expect(twiml).toContain('/prompts/mode-menu.wav?v=');
    expect(twiml).not.toContain('<Say');
  });

  it('says lines whose clip is missing or outdated, in one <Say>', async () => {
    const twiml = await hook(
      '/voice/mode',
      { attempt: '1' },
      { Digits: '1' },
      { prompts: library },
    );
    expect(says(twiml)).toHaveLength(1);
    expect(twiml).toContain(
      'Please choose a language. For Spanish, press 1. For French, press 2.',
    );
  });

  it('lets the gateway play the greeting while FourPoints connects', async () => {
    const twiml = await hook(
      '/voice/select',
      { mode: 'ai', v: menu.version },
      { Digits: '2' },
      { prompts: library },
    );
    expect(twiml).not.toContain('<Say');
    expect(twiml).toMatch(/^<\?xml[^>]*><Response><Connect /);
    expect(twiml).toContain(
      '<Parameter name="greeting" value="ai-connected-fr-fr"/>',
    );
    // No clip for German: Twilio says the greeting, and no parameter is sent.
    const german = await hook(
      '/voice/select',
      { mode: 'ai', v: menu.version },
      { Digits: '3' },
      { prompts: library },
    );
    expect(says(german)).toEqual([
      'You are connected to the German AI Interpreter. Please speak one person at a time. Press star when you are done.',
    ]);
    expect(german).not.toContain('name="greeting"');
  });
});

describe('approved recordings cover the IVR', () => {
  const prompts = PromptLibrary.load(BUNDLED_PROMPTS_DIR);
  const org = {
    org: '11111111-1111-4111-8111-111111111111',
    ai: '1',
    hu: '1',
    min: '30',
    leg: '0',
  };
  const accessWith = (result: ResolveResult | Error): AccessClient => ({
    resolve: async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    usage: async () => 'recorded',
  });
  const ok: ResolveResult = {
    outcome: 'OK',
    organizationId: org.org,
    employeeId: null,
    aiAllowed: true,
    humanAllowed: true,
    minutesRemaining: 30,
  };

  // Every webhook below runs with the approved recordings.
  const play = (
    path: string,
    query: Record<string, string>,
    body: Record<string, string>,
    ctx: Partial<IvrContext>,
  ) => hook(path, query, body, { prompts, ...ctx });

  it('has a matching clip for every line callers and interpreters hear', async () => {
    const twimls = await Promise.all([
      play('/voice/incoming', {}, {}, {}),
      play('/voice/mode', { attempt: '1' }, { Digits: '7' }, {}),
      play('/voice/mode', { attempt: '1' }, { Digits: '1' }, {}),
      play(
        '/voice/mode',
        { attempt: '1' },
        { Digits: '1' },
        { menu: EMPTY_MENU },
      ),
      ...menu.entries.flatMap((entry) => [
        play(
          '/voice/select',
          { mode: 'ai', v: menu.version },
          { Digits: entry.digits },
          {},
        ),
        play(
          '/voice/select',
          { mode: 'human', v: menu.version },
          { Digits: entry.digits },
          {},
        ),
        play('/voice/whisper', { lang: entry.languageId }, {}, {}),
      ]),
      play(
        '/voice/select',
        { mode: 'ai', v: menu.version },
        { Digits: '1' },
        { aiAvailable: false },
      ),
      play('/voice/whisper', {}, {}, {}),
      play('/voice/ai', {}, { Digits: '9' }, {}),
      play(
        '/voice/ai-ended',
        { lang: 'es-US' },
        { CallStatus: 'in-progress' },
        {},
      ),
      play(
        '/voice/human-result',
        { lang: 'es-US' },
        { DialCallStatus: 'no-answer' },
        {},
      ),
      play('/voice/human-result', {}, { DialCallStatus: 'no-answer' }, {}),
      // Organization line.
      play('/voice/org/incoming', {}, {}, {}),
      play('/voice/org/number', { attempt: '1' }, { Digits: '1' }, {}),
      play('/voice/org/number', { attempt: '3' }, { Digits: '1' }, {}),
      play('/voice/org/number', { attempt: '1' }, { Digits: '12' }, {}),
      play(
        '/voice/org/code',
        { n: '12', attempt: '1' },
        { Digits: '123456' },
        { access: accessWith({ outcome: 'INVALID' }) },
      ),
      play(
        '/voice/org/code',
        { n: '12', attempt: '3' },
        { Digits: '123456' },
        { access: accessWith({ outcome: 'INVALID' }) },
      ),
      play(
        '/voice/org/code',
        { n: '12', attempt: '1' },
        { Digits: '123456' },
        { access: accessWith({ outcome: 'NOT_ACTIVE' }) },
      ),
      play(
        '/voice/org/code',
        { n: '12', attempt: '1' },
        { Digits: '123456' },
        { access: accessWith({ outcome: 'QUOTA_EXHAUSTED' }) },
      ),
      play(
        '/voice/org/code',
        { n: '12', attempt: '1' },
        { Digits: '123456' },
        { access: accessWith(new Error('down')) },
      ),
      play(
        '/voice/org/code',
        { n: '12', attempt: '1' },
        { Digits: '123456' },
        {},
      ),
      play(
        '/voice/org/code',
        { n: '12', attempt: '1' },
        { Digits: '123456' },
        { access: accessWith(ok) },
      ),
      play(
        '/voice/org/code',
        { n: '12', attempt: '1' },
        { Digits: '123456' },
        {
          access: accessWith({ ...ok, humanAllowed: false }),
          menu: EMPTY_MENU,
        },
      ),
      play('/voice/mode', { ...org, attempt: '2' }, {}, {}),
      play('/voice/mode', { ...org, attempt: '3' }, {}, {}),
      play(
        '/voice/select',
        { ...org, hu: '0', mode: 'human', v: menu.version },
        { Digits: '1' },
        {},
      ),
    ]);
    const spoken = twimls.flatMap((twiml) => says(twiml));
    expect(spoken).toEqual([]);
  });
});

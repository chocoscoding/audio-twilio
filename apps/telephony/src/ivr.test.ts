import { describe, expect, it } from 'vitest';

import type { WireLanguageCapability } from '@fourpoints/protocol';

import { loadConfig } from './config.js';
import { handleVoiceWebhook, type IvrContext } from './ivr.js';
import { EMPTY_MENU, buildMenu } from './languages.js';

const BASE = 'https://phone.example.com';
const config = loadConfig({
  PUBLIC_BASE_URL: BASE,
  TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'token',
  HUMAN_INTERPRETER_NUMBERS: JSON.stringify({
    default: ['+15550000001', '+15550000002'],
    'es-US': ['+15550000003'],
  }),
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

function hook(
  path: string,
  query: Record<string, string> = {},
  body: Record<string, string> = {},
  overrides: Partial<IvrContext> = {},
): string {
  const ctx: IvrContext = { config, menu, aiAvailable: true, ...overrides };
  return (
    handleVoiceWebhook(
      path,
      new URLSearchParams(query),
      new URLSearchParams(body),
      ctx,
    ) ?? 'NOT FOUND'
  );
}

describe('IVR webhooks', () => {
  it('greets with the AI / human choice', () => {
    expect(hook('/voice/incoming')).toContain(
      `<Gather input="dtmf" numDigits="1" timeout="6" actionOnEmptyResult="true" action="${BASE}/voice/mode?attempt=1">`,
    );
  });

  it('reads the language menu from the registry, with two-digit entry', () => {
    const twiml = hook('/voice/mode', { attempt: '1' }, { Digits: '1' });
    expect(twiml).toContain('numDigits="2" finishOnKey="#" timeout="3"');
    expect(twiml).toContain(
      `action="${BASE}/voice/select?mode=ai&amp;v=${menu.version}&amp;attempt=1"`,
    );
    expect(twiml).toContain('For Spanish (US), press 1.');
    expect(twiml).toContain('For Arabic (Gulf), press 10.');
    expect(twiml).toContain('Then press pound.');
  });

  it('re-prompts on an invalid choice, then routes to a human', () => {
    const retry = hook('/voice/mode', { attempt: '1' }, { Digits: '7' });
    expect(retry).toContain('Sorry, that was not a valid choice.');
    expect(retry).toContain('attempt=2');
    const last = hook('/voice/mode', { attempt: '3' }, {});
    expect(last).toContain('<Dial');
    expect(last).toContain('+15550000001');
    expect(last).not.toContain('<Gather');
  });

  it('sends callers to a human when no AI language is available', () => {
    const twiml = hook(
      '/voice/mode',
      {},
      { Digits: '1' },
      { menu: EMPTY_MENU },
    );
    expect(twiml).toContain('The AI interpreter is not available right now.');
    expect(twiml).toContain('<Dial');
  });

  it('connects the AI stream with metadata in <Parameter>, never a query string', () => {
    const twiml = hook(
      '/voice/select',
      { mode: 'ai', v: menu.version },
      { Digits: '2' },
    );
    expect(twiml).toContain(
      `<Connect action="${BASE}/voice/ai-ended?lang=fr-FR">`,
    );
    expect(twiml).toContain(
      `<Stream url="wss://phone.example.com/media" statusCallback="${BASE}/voice/stream-status">`,
    );
    expect(twiml).toContain(
      '<Parameter name="clinicianLanguageId" value="en-US"/>',
    );
    expect(twiml).toContain(
      '<Parameter name="patientLanguageId" value="fr-FR"/>',
    );
  });

  it('re-reads the menu when the digits were collected against another version', () => {
    const twiml = hook(
      '/voice/select',
      { mode: 'ai', v: 'stale' },
      { Digits: '2' },
    );
    expect(twiml).toContain('Please choose a language.');
    expect(twiml).not.toContain('<Connect');
  });

  it('falls back to a human for that language when AI is at capacity', () => {
    const twiml = hook(
      '/voice/select',
      { mode: 'ai', v: menu.version },
      { Digits: '1' },
      { aiAvailable: false },
    );
    expect(twiml).toContain('The AI interpreter is not available right now.');
    expect(twiml).toContain(
      `<Number url="${BASE}/voice/whisper?lang=es-US">+15550000003</Number>`,
    );
  });

  it('dials language-specific interpreters with a screening whisper', () => {
    const twiml = hook(
      '/voice/select',
      { mode: 'human', v: menu.version },
      { Digits: '1' },
    );
    expect(twiml).toContain(`action="${BASE}/voice/human-result?lang=es-US"`);
    expect(twiml).toContain('+15550000003');
    expect(twiml).not.toContain('+15550000001');
  });

  it('offers a human when the AI stream ends while the caller is still on the line', () => {
    expect(
      hook('/voice/ai-ended', { lang: 'es-US' }, { CallStatus: 'completed' }),
    ).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(
      hook('/voice/ai-ended', { lang: 'es-US' }, { CallStatus: 'in-progress' }),
    ).toContain('<Dial');
  });

  it('offers AI after an unanswered human dial', () => {
    const twiml = hook(
      '/voice/human-result',
      { lang: 'es-US' },
      { DialCallStatus: 'no-answer' },
    );
    expect(twiml).toContain(`action="${BASE}/voice/ai?lang=es-US"`);
    expect(
      hook('/voice/human-result', {}, { DialCallStatus: 'completed' }),
    ).toContain('<Hangup/>');
    expect(hook('/voice/ai', { lang: 'es-US' }, { Digits: '1' })).toContain(
      '<Connect',
    );
    expect(hook('/voice/ai', { lang: 'es-US' }, {})).toContain('Goodbye.');
  });

  it('screens interpreters so voicemail cannot answer', () => {
    const whisper = hook('/voice/whisper', { lang: 'es-US' });
    expect(whisper).toContain(
      'FourPoints interpretation call for Spanish (US). Press 1 to accept.',
    );
    expect(whisper).toContain('<Hangup/>');
    expect(hook('/voice/whisper-accept', {}, { Digits: '1' })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response/>',
    );
    expect(hook('/voice/whisper-accept', {}, { Digits: '2' })).toContain(
      '<Hangup/>',
    );
  });

  it('escapes registry text and rejects unknown routes', () => {
    const odd = buildMenu(
      [voice('en-US', 'English'), voice('xx', 'R&D <Test>')],
      'en-US',
    );
    expect(hook('/voice/mode', {}, { Digits: '2' }, { menu: odd })).toContain(
      'For R&amp;D &lt;Test&gt;, press 1.',
    );
    expect(
      handleVoiceWebhook(
        '/voice/nope',
        new URLSearchParams(),
        new URLSearchParams(),
        {
          config,
          menu,
          aiAvailable: true,
        },
      ),
    ).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { WireLanguageCapability } from '@fourpoints/protocol';

import {
  EMPTY_MENU,
  LanguageRegistry,
  MAX_MENU_LANGUAGES,
  buildMenu,
  findByDigits,
  findByLanguage,
} from './languages.js';

export function language(
  languageId: string,
  displayName: string = languageId,
  speech = true,
): WireLanguageCapability {
  return {
    languageId,
    displayName,
    input: { speech, text: true },
    output: { speech, text: true },
    capabilityTier: speech ? 'FULL_VOICE' : 'TEXT_TRANSLATION',
    validationStatus: 'TECHNICALLY_VALIDATED',
  };
}

/** Shape of the FourPoints registry today (apps/realtime/src/languages.ts). */
export const FOURPOINTS_LANGUAGES: WireLanguageCapability[] = [
  language('en-US', 'English (US)'),
  language('es-US', 'Spanish (US)'),
  language('fr-FR', 'French (France)'),
  language('de-DE', 'German (Germany)'),
  language('it-IT', 'Italian (Italy)'),
  language('pt-BR', 'Portuguese (Brazil)'),
  language('hi-IN', 'Hindi (India)'),
  language('ja-JP', 'Japanese (Japan)'),
  language('ko-KR', 'Korean (South Korea)'),
  language('zh-CN', 'Mandarin Chinese (Simplified)'),
  language('ar-AE', 'Arabic (Gulf)'),
  language('ne-NP', 'Nepali', false),
];

describe('buildMenu', () => {
  it('offers every voice language except the clinician language', () => {
    const menu = buildMenu(FOURPOINTS_LANGUAGES, 'en-US');
    expect(menu.entries.map((e) => e.languageId)).toEqual([
      'es-US',
      'fr-FR',
      'de-DE',
      'it-IT',
      'pt-BR',
      'hi-IN',
      'ja-JP',
      'ko-KR',
      'zh-CN',
      'ar-AE',
    ]);
    expect(menu.entries.map((e) => e.digits)).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  it('puts configured languages first, in order', () => {
    const menu = buildMenu(FOURPOINTS_LANGUAGES, 'en-US', ['ar-AE', 'zh-CN']);
    expect(menu.entries.slice(0, 3).map((e) => e.languageId)).toEqual([
      'ar-AE',
      'zh-CN',
      'es-US',
    ]);
  });

  it('caps the menu at 14 languages', () => {
    const many = [
      language('en-US'),
      ...Array.from({ length: 20 }, (_, i) => language(`x-${i}`)),
    ];
    expect(buildMenu(many, 'en-US').entries).toHaveLength(MAX_MENU_LANGUAGES);
  });

  it('offers nothing when the clinician language cannot be spoken', () => {
    expect(buildMenu(FOURPOINTS_LANGUAGES, 'ne-NP')).toBe(EMPTY_MENU);
    expect(buildMenu([language('es-US')], 'en-US')).toBe(EMPTY_MENU);
  });

  it('versions the menu by its order', () => {
    const a = buildMenu(FOURPOINTS_LANGUAGES, 'en-US');
    expect(buildMenu(FOURPOINTS_LANGUAGES, 'en-US').version).toBe(a.version);
    expect(
      buildMenu(FOURPOINTS_LANGUAGES, 'en-US', ['ar-AE']).version,
    ).not.toBe(a.version);
  });

  it('finds entries by digits and by language', () => {
    const menu = buildMenu(FOURPOINTS_LANGUAGES, 'en-US');
    expect(findByDigits(menu, '10')?.languageId).toBe('ar-AE');
    expect(findByDigits(menu, '11')).toBeUndefined();
    expect(findByLanguage(menu, 'ja-JP')?.digits).toBe('7');
    expect(findByLanguage(menu, 'en-US')).toBeUndefined();
  });
});

describe('LanguageRegistry', () => {
  it('keeps the last good menu when FourPoints is unreachable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchLanguages = vi
      .fn<() => Promise<WireLanguageCapability[]>>()
      .mockResolvedValueOnce(FOURPOINTS_LANGUAGES)
      .mockRejectedValueOnce(new Error('connection refused'));
    const registry = new LanguageRegistry({
      fetchLanguages,
      clinicianLanguageId: 'en-US',
      order: [],
      refreshMs: 60_000,
    });
    expect(registry.menu).toBe(EMPTY_MENU);
    await registry.refresh();
    const good = registry.menu;
    expect(good.entries).toHaveLength(10);
    await registry.refresh();
    expect(registry.menu).toBe(good);
  });
});

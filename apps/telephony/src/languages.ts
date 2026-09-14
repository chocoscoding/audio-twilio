import { createHash } from 'node:crypto';

import type { WireLanguageCapability } from '@fourpoints/protocol';

import { log } from './log.js';

/** The phone menu offers at most 14 languages (digits 1–14). */
export const MAX_MENU_LANGUAGES = 14;

export interface MenuEntry {
  digits: string;
  languageId: string;
  displayName: string;
}

export interface LanguageMenu {
  /** Hash of the ordered language ids; travels in IVR URLs (see below). */
  version: string;
  entries: readonly MenuEntry[];
}

export const EMPTY_MENU: LanguageMenu = { version: 'none', entries: [] };

/**
 * Build the phone menu from the FourPoints registry projection. Only
 * languages that accept AND produce speech are offered, the clinician's own
 * language is excluded, and nothing is offered at all if the clinician
 * language itself cannot be spoken — the phone never promises a route the
 * backend cannot serve.
 */
export function buildMenu(
  languages: readonly WireLanguageCapability[],
  clinicianLanguageId: string,
  order: readonly string[] = [],
): LanguageMenu {
  const voice = languages.filter((l) => l.input.speech && l.output.speech);
  if (!voice.some((l) => l.languageId === clinicianLanguageId)) {
    return EMPTY_MENU;
  }
  const rank = (id: string): number => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  const entries = voice
    .filter((l) => l.languageId !== clinicianLanguageId)
    .map((language, index) => ({ language, index }))
    .sort(
      (a, b) =>
        rank(a.language.languageId) - rank(b.language.languageId) ||
        a.index - b.index,
    )
    .slice(0, MAX_MENU_LANGUAGES)
    .map(({ language }, i) => ({
      digits: String(i + 1),
      languageId: language.languageId,
      displayName: language.displayName,
    }));
  if (entries.length === 0) {
    return EMPTY_MENU;
  }
  const version = createHash('sha1')
    .update(entries.map((e) => e.languageId).join(','))
    .digest('hex')
    .slice(0, 8);
  return { version, entries };
}

export function findByDigits(
  menu: LanguageMenu,
  digits: string | null,
): MenuEntry | undefined {
  return menu.entries.find((entry) => entry.digits === digits);
}

export function findByLanguage(
  menu: LanguageMenu,
  languageId: string | null,
): MenuEntry | undefined {
  return menu.entries.find((entry) => entry.languageId === languageId);
}

export interface LanguageRegistryOptions {
  fetchLanguages: () => Promise<WireLanguageCapability[]>;
  clinicianLanguageId: string;
  order: readonly string[];
  refreshMs: number;
}

/**
 * Last-known-good menu, refreshed on a timer. Each gateway instance refreshes
 * independently — no shared store. Because the menu version is carried in the
 * IVR action URLs, a keypress collected by one instance is never interpreted
 * against a different menu on another instance.
 */
export class LanguageRegistry {
  private current: LanguageMenu = EMPTY_MENU;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: LanguageRegistryOptions) {}

  get menu(): LanguageMenu {
    return this.current;
  }

  async refresh(): Promise<void> {
    try {
      const languages = await this.options.fetchLanguages();
      this.current = buildMenu(
        languages,
        this.options.clinicianLanguageId,
        this.options.order,
      );
      log('languages.refreshed', {
        version: this.current.version,
        count: this.current.entries.length,
      });
    } catch (error) {
      // Keep serving the last good menu; an empty menu routes callers to
      // human interpreters rather than to an unreachable AI.
      log('languages.refresh_failed', {
        reason: error instanceof Error ? error.message : 'unknown',
        keptVersion: this.current.version,
      });
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

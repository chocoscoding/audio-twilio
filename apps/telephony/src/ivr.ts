/**
 * Twilio voice webhooks → TwiML. Pure functions of (route, request, context):
 * no call state is kept between webhooks — everything a later step needs
 * travels in the Twilio-signed action URL — so any gateway instance can
 * answer any webhook.
 */

import type { TelephonyConfig } from './config.js';
import {
  findByDigits,
  findByLanguage,
  type LanguageMenu,
  type MenuEntry,
} from './languages.js';
import { element, escapeXml, response, say } from './twiml.js';

export interface IvrContext {
  config: TelephonyConfig;
  menu: LanguageMenu;
  /** False while this instance is draining or at its AI call limit. */
  aiAvailable: boolean;
}

type Mode = 'ai' | 'human';

const MAX_ATTEMPTS = 3;

/** TwiML for one webhook, or null when the route does not exist. */
export function handleVoiceWebhook(
  path: string,
  query: URLSearchParams,
  body: URLSearchParams,
  ctx: IvrContext,
): string | null {
  const { config, menu } = ctx;
  const digits = body.get('Digits');
  const attempt = Math.min(
    Math.max(Number(query.get('attempt')) || 1, 1),
    MAX_ATTEMPTS,
  );
  const mode: Mode = query.get('mode') === 'ai' ? 'ai' : 'human';
  const language = findByLanguage(menu, query.get('lang'));

  const url = (
    route: string,
    params: Record<string, string | number | undefined> = {},
  ) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        search.set(key, String(value));
      }
    }
    const qs = search.toString();
    return `${config.publicBaseUrl}${route}${qs === '' ? '' : `?${qs}`}`;
  };

  const modeMenu = (tries: number) =>
    response(
      element(
        'Gather',
        {
          input: 'dtmf',
          numDigits: 1,
          timeout: 6,
          actionOnEmptyResult: true,
          action: url('/voice/mode', { attempt: tries }),
        },
        say(
          `${tries > 1 ? 'Sorry, that was not a valid choice. ' : 'Welcome to FourPoints interpretation. '}` +
            'For an AI interpreter, press 1. For a human interpreter, press 2.',
        ),
      ),
    );

  const languageMenu = (menuMode: Mode, tries: number) => {
    const twoDigits = menu.entries.length > 9;
    const options = menu.entries
      .map((entry) => `For ${entry.displayName}, press ${entry.digits}.`)
      .join(' ');
    return response(
      element(
        'Gather',
        {
          input: 'dtmf',
          numDigits: twoDigits ? 2 : 1,
          finishOnKey: '#',
          timeout: twoDigits ? 3 : 6,
          actionOnEmptyResult: true,
          action: url('/voice/select', {
            mode: menuMode,
            v: menu.version,
            attempt: tries,
          }),
        },
        say(
          `${tries > 1 ? 'Sorry, that was not a valid choice. ' : ''}` +
            `Please choose a language. ${options}` +
            `${twoDigits ? ' Then press pound.' : ''}`,
        ),
      ),
    );
  };

  const dialHuman = (entry: MenuEntry | undefined): string[] => {
    const numbers =
      (entry === undefined
        ? undefined
        : config.humanNumbers[entry.languageId]) ??
      config.humanNumbers['default'] ??
      [];
    return [
      say(
        entry === undefined
          ? 'Connecting you to a human interpreter. Please hold.'
          : `Connecting you to a human interpreter for ${entry.displayName}. Please hold.`,
      ),
      element(
        'Dial',
        {
          answerOnBridge: true,
          timeout: 30,
          action: url('/voice/human-result', { lang: entry?.languageId }),
        },
        ...numbers.map((number) =>
          element(
            'Number',
            { url: url('/voice/whisper', { lang: entry?.languageId }) },
            escapeXml(number),
          ),
        ),
      ),
    ];
  };

  const connectAi = (entry: MenuEntry): string[] => [
    say(
      `Connecting the AI interpreter for ${entry.displayName}. ` +
        'Speak one at a time after the tone: a low tone for the clinician, ' +
        'a high tone for the patient. Press star to switch speakers.',
    ),
    element(
      'Connect',
      { action: url('/voice/ai-ended', { lang: entry.languageId }) },
      element(
        'Stream',
        {
          // Twilio forbids query strings here; metadata goes in <Parameter>.
          url: `${config.publicBaseUrl.replace(/^http/, 'ws')}/media`,
          statusCallback: url('/voice/stream-status'),
        },
        element('Parameter', {
          name: 'clinicianLanguageId',
          value: config.clinicianLanguageId,
        }),
        element('Parameter', {
          name: 'patientLanguageId',
          value: entry.languageId,
        }),
      ),
    ),
  ];

  const aiOrHuman = (entry: MenuEntry): string =>
    ctx.aiAvailable
      ? response(...connectAi(entry))
      : response(
          say('The AI interpreter is not available right now.'),
          ...dialHuman(entry),
        );

  switch (path) {
    case '/voice/incoming':
      return modeMenu(1);

    case '/voice/mode':
      if (digits === '1' || digits === '2') {
        if (menu.entries.length === 0) {
          return response(
            ...(digits === '1'
              ? [say('The AI interpreter is not available right now.')]
              : []),
            ...dialHuman(undefined),
          );
        }
        return languageMenu(digits === '1' ? 'ai' : 'human', 1);
      }
      return attempt >= MAX_ATTEMPTS
        ? response(...dialHuman(undefined))
        : modeMenu(attempt + 1);

    case '/voice/select': {
      if (menu.entries.length === 0) {
        return response(...dialHuman(undefined));
      }
      if (query.get('v') !== menu.version) {
        // The menu changed since it was read out; read the current one.
        return languageMenu(mode, attempt);
      }
      const entry = findByDigits(menu, digits);
      if (entry === undefined) {
        return attempt >= MAX_ATTEMPTS
          ? response(...dialHuman(undefined))
          : languageMenu(mode, attempt + 1);
      }
      return mode === 'ai' ? aiOrHuman(entry) : response(...dialHuman(entry));
    }

    case '/voice/ai':
      // Reached from the "try AI instead" offer after a failed human dial.
      if (digits !== '1' || language === undefined || !ctx.aiAvailable) {
        return response(say('Goodbye.'), element('Hangup'));
      }
      return response(...connectAi(language));

    case '/voice/ai-ended':
      // The caller hanging up ends everything; any other end means the
      // gateway closed the stream (backend unavailable or at capacity).
      if (body.get('CallStatus') === 'completed') {
        return response();
      }
      return response(
        say('The AI interpreter is unavailable.'),
        ...dialHuman(language),
      );

    case '/voice/human-result':
      if (body.get('DialCallStatus') === 'completed') {
        return response(element('Hangup'));
      }
      if (language !== undefined && ctx.aiAvailable) {
        return response(
          say('Sorry, no interpreter is available right now.'),
          element(
            'Gather',
            {
              input: 'dtmf',
              numDigits: 1,
              timeout: 6,
              action: url('/voice/ai', { lang: language.languageId }),
            },
            say('To use the AI interpreter instead, press 1.'),
          ),
          say('Goodbye.'),
          element('Hangup'),
        );
      }
      return response(
        say(
          'Sorry, no interpreter is available right now. Please try again later. Goodbye.',
        ),
        element('Hangup'),
      );

    case '/voice/whisper':
      // Heard only by the interpreter. Requiring a keypress stops a
      // voicemail greeting from "answering" the caller.
      return response(
        element(
          'Gather',
          {
            input: 'dtmf',
            numDigits: 1,
            timeout: 8,
            action: url('/voice/whisper-accept'),
          },
          say(
            `FourPoints interpretation call${language === undefined ? '' : ` for ${language.displayName}`}. ` +
              'Press 1 to accept.',
          ),
        ),
        element('Hangup'),
      );

    case '/voice/whisper-accept':
      return digits === '1' ? response() : response(element('Hangup'));

    case '/voice/status':
    case '/voice/stream-status':
      return response();

    default:
      return null;
  }
}

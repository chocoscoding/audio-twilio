/**
 * Twilio voice webhooks → TwiML. Functions of (route, request, context):
 * no call state is kept between webhooks — everything a later step needs
 * travels in the Twilio-signed action URL — so any gateway instance can
 * answer any webhook.
 *
 * Two entry points:
 *   /voice/incoming      the CURRENT number: AI or human, unchanged.
 *   /voice/org/incoming  the ORGANIZATION line (new number): organization
 *                        ID, then access code, checked by FourPoints
 *                        (SoT sections 6, 12). After a valid code the call
 *                        carries a grant (organization, employee, what it
 *                        may use, minutes left) in its signed action URLs,
 *                        and each AI or human leg is reported for usage.
 *                        The organization is never put in the media stream.
 *                        A call arriving on a company's own number
 *                        (companies.ts) hears the company's welcome and
 *                        skips the organization ID; FourPoints says whether
 *                        it must still enter a code.
 *
 * During a call, ### switches between AI and human (at most MAX_SWITCHES
 * times): from AI, the gateway closes the stream and /voice/ai-ended dials a
 * human; from a human, the /watch stream hears the tones and releases the
 * interpreter, and /voice/human-result reads out the language menu.
 */

import type { AccessClient, LineResult } from './access.js';
import type { Company, CompanySource } from './companies.js';
import type { TelephonyConfig } from './config.js';
import {
  findByDigits,
  findByLanguage,
  type LanguageMenu,
  type MenuEntry,
} from './languages.js';
import type { PromptLibrary } from './prompts.js';
import type { RelayOutcome } from './relay.js';
import { element, escapeXml, response, say } from './twiml.js';

export interface IvrContext {
  config: TelephonyConfig;
  menu: LanguageMenu;
  /** False while this instance is draining or at its AI call limit. */
  aiAvailable: boolean;
  /** The FourPoints phone API; the organization line needs it. */
  access?: AccessClient;
  /** Recorded prompts; any line without a matching clip is a <Say>. */
  prompts?: PromptLibrary;
  /** Companies with a number of their own. */
  companies?: CompanySource;
  /**
   * True when human calls to a company's own interpreter line are relayed
   * through the gateway (relay.ts), so ### during them can switch to the AI.
   */
  humanRelay?: boolean;
  /** Why the relay for a call ended, once (relay.ts RelayHub.take). */
  relayOutcome?: (callSid: string) => RelayOutcome | undefined;
  /** Content-free operational log. */
  log?: (
    event: string,
    fields?: Record<string, string | number | boolean>,
  ) => void;
}

type Mode = 'ai' | 'human';
/** One spoken line: recorded clip id (ivr-audio/script.mjs) and its text. */
export type Line = readonly [id: string, text: string];

const WELCOME: Line = ['welcome', 'Welcome to FourPoints interpretation.'];
const THANK_YOU: Line = ['thank-you', 'Thank you.'];
const GOODBYE: Line = ['goodbye', 'Goodbye.'];
const AI_NOT_AVAILABLE: Line = [
  'ai-not-available',
  'The AI interpreter is not available right now.',
];
const CODE_NOT_RECOGNIZED: Line = [
  'code-not-recognized',
  'Sorry, that organization ID or access code was not recognized.',
];
/** A company's own number: no organization ID was typed. */
const CODE_INVALID: Line = [
  'code-invalid',
  'Sorry, that access code was not recognized.',
];
const HUMAN_CONNECTING: Line = [
  'human-connecting',
  'Connecting you to a human interpreter. Please hold.',
];
const SWITCH_TO_AI: Line = [
  'switch-to-ai',
  'Switching you to the AI interpreter.',
];
/** Heard by the interpreter when the caller switches to the AI. */
export const INTERPRETER_RELEASED: Line = [
  'interpreter-released',
  'The caller has switched to the AI interpreter. Goodbye.',
];

/** The company's own welcome, recorded by the owner (ivr-audio import). */
export const companyWelcome = (company: Company): Line => [
  `welcome-org-${company.orgNumber}`,
  company.welcome ?? `Welcome to ${company.companyName}.`,
];

/** Clip-id suffix for a language: es-US → es-us. */
const clipKey = (languageId: string) => languageId.toLowerCase();

/** English part of the AI greeting; the clip goes on in the caller's language. */
export const aiGreeting = (entry: MenuEntry): Line => [
  `ai-connected-${clipKey(entry.languageId)}`,
  `You are connected to the ${entry.displayName} AI Interpreter. ` +
    'Please speak one person at a time. Press star when you are done.',
];

const MAX_ATTEMPTS = 3;
/** ### switches between AI and human at most this many times per call. */
export const MAX_SWITCHES = 3;
/**
 * Seconds Twilio waits for a key — before the first and between digits —
 * after the prompt ends. Callers said 6 s felt rushed (owner, 2026-10-13).
 * Pound still ends an entry at once, so a longer wait slows no one down.
 */
const MENU_TIMEOUT_S = 10;
/** Organization ID and access code: several digits, often read off a card. */
const ENTRY_TIMEOUT_S = 12;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_SID = /^CA[0-9a-f]{32}$/;

/** What a valid organization code allows this call; travels in signed URLs. */
interface CallGrant {
  org: string;
  emp: string | undefined;
  ai: boolean;
  human: boolean;
  minutes: number;
  /** Interpretation legs started so far on this call. */
  leg: number;
  /** orgNumber of a listed company (companies.ts), for its own interpreters. */
  company: number | undefined;
}

function readGrant(query: URLSearchParams): CallGrant | undefined {
  const org = query.get('org');
  if (org === null || !GUID.test(org)) {
    return undefined;
  }
  const emp = query.get('emp');
  const company = Number(query.get('co'));
  return {
    org,
    emp: emp !== null && GUID.test(emp) ? emp : undefined,
    ai: query.get('ai') === '1',
    human: query.get('hu') === '1',
    minutes: Math.max(Number(query.get('min')) || 0, 0),
    leg: Math.min(Math.max(Number(query.get('leg')) || 0, 0), 20),
    company: Number.isInteger(company) && company >= 10 ? company : undefined,
  };
}

/**
 * Lines → TwiML: a <Play> per line with a matching recorded clip; the rest
 * as <Say>, adjacent ones merged so they read as one sentence as before.
 */
export function speakLines(
  config: TelephonyConfig,
  prompts: PromptLibrary | undefined,
  ...lines: Line[]
): string[] {
  const out: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length > 0) {
      out.push(say(pending.join(' ')));
      pending = [];
    }
  };
  for (const [id, text] of lines) {
    const clip = prompts?.match(id, text);
    if (clip === undefined) {
      pending.push(text);
      continue;
    }
    flush();
    out.push(
      element(
        'Play',
        {},
        escapeXml(
          `${config.publicBaseUrl}/prompts/${clip.id}.wav?v=${clip.version}`,
        ),
      ),
    );
  }
  flush();
  return out;
}

/** TwiML for one webhook, or null when the route does not exist. */
export async function handleVoiceWebhook(
  path: string,
  query: URLSearchParams,
  body: URLSearchParams,
  ctx: IvrContext,
): Promise<string | null> {
  const { config, menu } = ctx;
  const log = ctx.log ?? (() => undefined);
  let grant = readGrant(query);
  const canAi = () => grant === undefined || grant.ai;
  const canHuman = () => grant === undefined || grant.human;
  const digits = body.get('Digits');
  const attempt = Math.min(
    Math.max(Number(query.get('attempt')) || 1, 1),
    MAX_ATTEMPTS,
  );
  const mode: Mode = query.get('mode') === 'ai' ? 'ai' : 'human';
  const language = findByLanguage(menu, query.get('lang'));
  let switches = Math.min(
    Math.max(Number(query.get('sw')) || 0, 0),
    MAX_SWITCHES,
  );
  const canSwitch = () => !config.presentationMode && switches < MAX_SWITCHES;
  /** The listed company this call belongs to, if any. */
  const company = (): Company | undefined =>
    grant?.company === undefined
      ? undefined
      : ctx.companies?.byOrgNumber(grant.company);
  /** The company's own interpreter line (OPI), if it has one. */
  const companyHuman = () => company()?.humanNumber;

  const url = (
    route: string,
    params: Record<string, string | number | undefined> = {},
  ) => {
    const search = new URLSearchParams();
    const carried =
      grant === undefined
        ? {}
        : {
            org: grant.org,
            emp: grant.emp,
            ai: grant.ai ? 1 : 0,
            hu: grant.human ? 1 : 0,
            min: grant.minutes,
            leg: grant.leg,
            co: grant.company,
          };
    for (const [key, value] of Object.entries({
      ...carried,
      sw: switches === 0 ? undefined : switches,
      ...params,
    })) {
      if (value !== undefined) {
        search.set(key, String(value));
      }
    }
    const qs = search.toString();
    return `${config.publicBaseUrl}${route}${qs === '' ? '' : `?${qs}`}`;
  };

  const speak = (...lines: Line[]): string[] =>
    speakLines(config, ctx.prompts, ...lines);

  // The organization line never picks for the caller: no input is said as
  // such and asked again, and after the last try the call ends (owner
  // request 2026-10-02). The pound key is ignored in its one-key menus, so a
  // pound pressed after the access code cannot count as a choice. The
  // current number keeps its original behaviour.
  const orgLine = () => grant !== undefined;
  const retryLead = (tries: number): Line[] =>
    tries <= 1
      ? []
      : orgLine() && (digits ?? '') === ''
        ? [['retry-no-input', 'You have not made a choice yet.']]
        : [['retry-invalid', 'Sorry, that was not a valid choice.']];
  const noChoice = () =>
    goodbye(
      'no-choice',
      'We did not receive a choice. Please call again when you are ready.',
    );

  const modeMenu = (tries: number, first?: Line) =>
    response(
      element(
        'Gather',
        {
          input: 'dtmf',
          numDigits: 1,
          timeout: MENU_TIMEOUT_S,
          ...(orgLine() ? { finishOnKey: '' } : {}),
          actionOnEmptyResult: true,
          action: url('/voice/mode', { attempt: tries }),
        },
        ...speak(
          ...(tries > 1
            ? retryLead(tries)
            : [first ?? (grant !== undefined ? THANK_YOU : WELCOME)]),
          company()?.humanFirst === true
            ? [
                'mode-menu-human-first',
                'For a human interpreter, press 1. For an AI interpreter, press 2.',
              ]
            : [
                'mode-menu',
                'For an AI interpreter, press 1. For a human interpreter, press 2.',
              ],
        ),
      ),
    );

  /** `before`: verbs ahead of the menu (stopping the ### watch stream). */
  const languageMenu = (
    menuMode: Mode,
    tries: number,
    lead: Line[] = [],
    before: string[] = [],
  ) => {
    // Up to 10 languages are one key each (the tenth is 0).
    const twoDigits = menu.entries.some((entry) => entry.digits.length > 1);
    const options = menu.entries.map((entry): Line => [
      `language-option-${clipKey(entry.languageId)}`,
      `For ${entry.displayName}, press ${entry.digits}.`,
    ]);
    return response(
      ...before,
      element(
        'Gather',
        {
          input: 'dtmf',
          numDigits: twoDigits ? 2 : 1,
          finishOnKey: '#',
          timeout: twoDigits ? 3 : MENU_TIMEOUT_S,
          actionOnEmptyResult: true,
          action: url('/voice/select', {
            mode: menuMode,
            v: menu.version,
            attempt: tries,
          }),
        },
        ...speak(
          ...lead,
          ...retryLead(tries),
          ['language-menu-intro', 'Please choose a language.'],
          ...options,
          ...(twoDigits
            ? [['language-menu-pound', 'Then press pound.'] as const]
            : []),
        ),
      ),
    );
  };

  const dialHuman = (entry: MenuEntry | undefined): string[] => {
    // A company's own interpreter line answers with its own menu or queue:
    // no language, and no press-1 screening nobody there would answer.
    const opi = companyHuman();
    const numbers =
      opi !== undefined
        ? [opi]
        : ((entry === undefined
            ? undefined
            : config.humanNumbers[entry.languageId]) ??
          config.humanNumbers['default'] ??
          []);
    const limit =
      grant === undefined ? undefined : Math.max(grant.minutes, 1) * 60;
    // A company's own line goes through the gateway, which then sees ###
    // (relay.ts); Twilio <Dial> would hide every keypress.
    if (opi !== undefined && ctx.humanRelay === true) {
      return [
        ...speak(HUMAN_CONNECTING),
        element(
          'Connect',
          { action: url('/voice/relay-ended', { lang: entry?.languageId }) },
          element(
            'Stream',
            { url: `${config.publicBaseUrl.replace(/^http/, 'ws')}/relay` },
            ...(entry === undefined
              ? []
              : [
                  element('Parameter', {
                    name: 'lang',
                    value: entry.languageId,
                  }),
                ]),
            ...(limit === undefined
              ? []
              : [
                  element('Parameter', { name: 'limit', value: String(limit) }),
                ]),
            // A yes/no only: never the organization.
            ...(canSwitch() && canAi() && menu.entries.length > 0
              ? [element('Parameter', { name: 'switch', value: '1' })]
              : []),
          ),
        ),
      ];
    }
    return [
      ...speak(
        entry === undefined || opi !== undefined
          ? HUMAN_CONNECTING
          : [
              `human-connecting-${clipKey(entry.languageId)}`,
              `Connecting you to a human interpreter for ${entry.displayName}. Please hold.`,
            ],
      ),
      element(
        'Dial',
        {
          answerOnBridge: true,
          timeout: 30,
          // Organization line: never past the minutes left this month.
          timeLimit: limit,
          action: url('/voice/human-result', { lang: entry?.languageId }),
        },
        ...numbers.map((number) =>
          element(
            'Number',
            opi !== undefined
              ? {}
              : { url: url('/voice/whisper', { lang: entry?.languageId }) },
            escapeXml(number),
          ),
        ),
      ),
    ];
  };

  /**
   * With a recorded greeting the stream opens at once and the gateway plays
   * the greeting itself while the FourPoints session opens (call.ts), so
   * the two waits overlap. Without one, Twilio says it first, as before.
   * Presentation mode passes its own intro.
   */
  const connectAi = (entry: MenuEntry, intro?: string): string[] => {
    const greeting =
      intro === undefined
        ? ctx.prompts?.match(...aiGreeting(entry))
        : undefined;
    return [
      ...(greeting !== undefined
        ? []
        : intro !== undefined
          ? [say(intro)]
          : speak(aiGreeting(entry))),
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
          // ### may go to a human. A yes/no only: never the organization.
          ...(intro === undefined && canSwitch() && canHuman()
            ? [element('Parameter', { name: 'transfer', value: '1' })]
            : []),
          ...(greeting === undefined
            ? []
            : [element('Parameter', { name: 'greeting', value: greeting.id })]),
        ),
      ),
    ];
  };

  const callSid = body.get('CallSid') ?? '';
  const goodbye = (id: string, text: string) =>
    response(...speak([id, `${text} Goodbye.`]), element('Hangup'));
  const notAvailable = () =>
    goodbye(
      'org-not-available',
      'Phone interpretation is not available for your organization right now. Please contact your administrator.',
    );

  /**
   * Organization line: report a new interpretation leg. False when
   * FourPoints refuses it (the organization was paused or lost phone
   * access since the code was entered). If the report cannot be made the
   * call still goes ahead, and the failure is logged.
   */
  const startLeg = async (
    mode: 'AI' | 'HUMAN',
    entry: MenuEntry | undefined,
  ): Promise<boolean> => {
    if (grant === undefined) {
      return true;
    }
    const leg = grant.leg + 1;
    if (ctx.access === undefined || !CALL_SID.test(callSid)) {
      log('usage.unrecorded', { mode });
    } else {
      const result = await ctx.access.usage({
        event: 'start',
        callSid,
        leg,
        organizationId: grant.org,
        ...(grant.emp === undefined ? {} : { employeeId: grant.emp }),
        mode,
        ...(entry === undefined ? {} : { languageId: entry.languageId }),
      });
      if (result === 'refused') {
        return false;
      }
      if (result === 'error') {
        log('usage.start_failed', { mode });
      }
    }
    grant = { ...grant, leg };
    return true;
  };
  const endLeg = async (mode: 'AI' | 'HUMAN'): Promise<void> => {
    if (
      grant === undefined ||
      grant.leg === 0 ||
      ctx.access === undefined ||
      !CALL_SID.test(callSid)
    ) {
      return;
    }
    const result = await ctx.access.usage({
      event: 'end',
      callSid,
      leg: grant.leg,
      organizationId: grant.org,
      mode,
    });
    if (result !== 'recorded') {
      log('usage.end_failed', { mode });
    }
  };

  /** Nobody answered: offer the AI where it can help, else goodbye. */
  const noInterpreter = (): string => {
    // The organization line also offers the AI when no language was chosen
    // (a company's own interpreter line); the current number does not.
    if (
      (language !== undefined || (orgLine() && menu.entries.length > 0)) &&
      ctx.aiAvailable &&
      canAi()
    ) {
      return response(
        ...speak([
          'no-interpreter',
          'Sorry, no interpreter is available right now.',
        ]),
        element(
          'Gather',
          {
            input: 'dtmf',
            numDigits: 1,
            timeout: MENU_TIMEOUT_S,
            action: url('/voice/ai', { lang: language?.languageId }),
          },
          ...speak(['offer-ai', 'To use the AI interpreter instead, press 1.']),
        ),
        ...speak(GOODBYE),
        element('Hangup'),
      );
    }
    return response(
      ...speak([
        'no-interpreter-final',
        'Sorry, no interpreter is available right now. Please try again later. Goodbye.',
      ]),
      element('Hangup'),
    );
  };

  const human = async (
    entry: MenuEntry | undefined,
    lead: string[] = [],
  ): Promise<string> => {
    if (!canHuman()) {
      return response(
        ...lead,
        ...speak([
          'human-not-included',
          'A human interpreter is not included for your organization. Goodbye.',
        ]),
        element('Hangup'),
      );
    }
    if (!(await startLeg('HUMAN', entry))) {
      return notAvailable();
    }
    return response(...lead, ...dialHuman(entry));
  };
  const ai = async (entry: MenuEntry): Promise<string> =>
    (await startLeg('AI', entry))
      ? response(...connectAi(entry))
      : notAvailable();

  const aiOrHuman = (entry: MenuEntry): Promise<string> =>
    ctx.aiAvailable ? ai(entry) : human(entry, speak(AI_NOT_AVAILABLE));

  const orgNumberPrompt = (tries: number, lead: Line) =>
    response(
      element(
        'Gather',
        {
          // No digit count: the caller's pound ends the entry, so it is
          // never left over for the next menu. Silence also ends it.
          input: 'dtmf',
          finishOnKey: '#',
          timeout: ENTRY_TIMEOUT_S,
          actionOnEmptyResult: true,
          action: url('/voice/org/number', { attempt: tries }),
        },
        ...speak(lead, [
          'org-id-prompt',
          'Please enter your organization ID, then press pound.',
        ]),
      ),
    );
  /** `dedicated`: a company's own number, where no organization ID was typed. */
  const codePrompt = (
    orgNumber: number,
    tries: number,
    lead: Line[] = [],
    dedicated = false,
  ) =>
    response(
      element(
        'Gather',
        {
          input: 'dtmf',
          finishOnKey: '#',
          timeout: ENTRY_TIMEOUT_S,
          actionOnEmptyResult: true,
          action: url('/voice/org/code', {
            n: orgNumber,
            attempt: tries,
            dl: dedicated ? 1 : undefined,
          }),
        },
        ...speak(...lead, [
          'code-prompt',
          'Please enter your six digit access code, then press pound.',
        ]),
      ),
    );
  const notRecognized = () => {
    const dedicated = query.get('dl') === '1';
    const lead = dedicated ? CODE_INVALID : CODE_NOT_RECOGNIZED;
    if (attempt >= MAX_ATTEMPTS) {
      return response(...speak(lead, GOODBYE), element('Hangup'));
    }
    return dedicated
      ? codePrompt(Number(query.get('n')), attempt + 1, [lead], true)
      : orgNumberPrompt(attempt + 1, lead);
  };
  const lineUnavailable = () =>
    goodbye('line-unavailable', 'This line is not available right now.');
  const quotaExhausted = () =>
    goodbye(
      'quota-exhausted',
      'Your organization has used all of its interpretation minutes for this month. Please contact your administrator.',
    );

  /** Human chosen: a company's own line rings at once, with no language menu. */
  const chooseHuman = (tries: number, lead: Line[] = []) =>
    companyHuman() !== undefined
      ? human(undefined, speak(...lead))
      : languageMenu('human', tries, lead);

  /**
   * Access granted (a valid code, or a company number that needs none):
   * the menus the grant allows. `welcome` is the company's welcome when
   * nothing has been said yet; otherwise the AI/human menu opens with
   * "Thank you." as before.
   */
  const afterAccess = async (welcome?: Line): Promise<string> => {
    if (grant === undefined || (!grant.ai && !grant.human)) {
      return notAvailable();
    }
    const lead = welcome === undefined ? [] : [welcome];
    if (menu.entries.length === 0) {
      return grant.human
        ? human(undefined, speak(...lead))
        : goodbye(
            'ai-try-later',
            'The AI interpreter is not available right now. Please try again later.',
          );
    }
    if (grant.ai && grant.human) {
      return modeMenu(1, welcome);
    }
    return grant.ai ? languageMenu('ai', 1, lead) : chooseHuman(1, lead);
  };

  /** The organization line's code check. Fails closed. */
  const checkCode = async (): Promise<string> => {
    const orgNumber = Number(query.get('n'));
    const code = digits ?? '';
    if (
      !Number.isInteger(orgNumber) ||
      orgNumber < 10 ||
      !/^\d{6}$/.test(code)
    ) {
      return notRecognized();
    }
    if (ctx.access === undefined) {
      return lineUnavailable();
    }
    let result;
    try {
      result = await ctx.access.resolve(orgNumber, code);
    } catch {
      log('access.resolve_failed');
      return goodbye(
        'code-check-failed',
        'Sorry, we cannot check your access code right now. Please call again in a few minutes.',
      );
    }
    log('access.resolved', { outcome: result.outcome });
    switch (result.outcome) {
      case 'INVALID':
        return notRecognized();
      case 'NOT_ACTIVE':
      case 'NO_PHONE_ACCESS':
        return notAvailable();
      case 'QUOTA_EXHAUSTED':
        return quotaExhausted();
      case 'OK':
        break;
    }
    // A listed company keeps its own interpreters on the shared line too,
    // but only when the code resolved to the organization the list names.
    const listed = ctx.companies?.byOrgNumber(orgNumber);
    if (
      query.get('dl') === '1' &&
      listed?.organizationId !== result.organizationId
    ) {
      log('access.line_mismatch');
      return lineUnavailable();
    }
    grant = {
      org: result.organizationId,
      emp: result.employeeId ?? undefined,
      ai: result.aiAllowed,
      human: result.humanAllowed,
      minutes: result.minutesRemaining,
      leg: 0,
      company:
        listed?.organizationId === result.organizationId
          ? orgNumber
          : undefined,
    };
    return afterAccess();
  };

  /**
   * A call on a company's own number. FourPoints decides whether the caller
   * must still enter a code (the organization has an organization-wide
   * code, active or paused) or goes straight in. Fails closed.
   */
  const companyLine = async (listed: Company): Promise<string> => {
    if (ctx.access === undefined) {
      return lineUnavailable();
    }
    let result: LineResult;
    try {
      result = await ctx.access.line(listed.orgNumber, listed.organizationId);
    } catch {
      log('access.line_failed');
      return lineUnavailable();
    }
    log('access.line', { outcome: result.outcome });
    switch (result.outcome) {
      case 'CODE_REQUIRED':
        return codePrompt(listed.orgNumber, 1, [companyWelcome(listed)], true);
      case 'INVALID':
        // The list's organizationId does not belong to its orgNumber.
        return lineUnavailable();
      case 'NOT_ACTIVE':
      case 'NO_PHONE_ACCESS':
        return notAvailable();
      case 'QUOTA_EXHAUSTED':
        return quotaExhausted();
      case 'OK':
        break;
    }
    if (result.organizationId !== listed.organizationId) {
      log('access.line_mismatch');
      return lineUnavailable();
    }
    grant = {
      org: result.organizationId,
      emp: undefined,
      ai: result.aiAllowed,
      human: result.humanAllowed,
      minutes: result.minutesRemaining,
      leg: 0,
      company: listed.orgNumber,
    };
    return afterAccess(companyWelcome(listed));
  };

  // Presentation mode: same menus, but each route announces its destination.
  const announce = (text: string): string =>
    response(
      say(text),
      element('Pause', { length: 2 }),
      say('Thank you for calling FourPoints. Goodbye.'),
      element('Hangup'),
    );
  // Rings HUMAN_INTERPRETER_NUMBER when set; otherwise only announces.
  // No press-1 screening here, so whoever answers is connected at once.
  const announceHuman = () => {
    const numbers = config.humanNumbers['default'];
    if (numbers === undefined) {
      return announce('You are being routed to a human interpreter.');
    }
    return response(
      say('You are being routed to a human interpreter. Please hold.'),
      element(
        'Dial',
        {
          answerOnBridge: true,
          timeout: 30,
          action: url('/voice/human-result'),
        },
        ...numbers.map((number) => element('Number', {}, escapeXml(number))),
      ),
    );
  };
  // Opens a real Twilio Media Stream; the gateway plays the caller's words
  // back so the audio path in both directions can be seen and heard.
  const announceAi = (entry: MenuEntry) =>
    response(
      ...connectAi(
        entry,
        `You are connected to the AI interpreter. This is the ${entry.displayName} language stream. ` +
          'After the beep, say something, and you will hear it played back.',
      ),
    );

  if (config.presentationMode) {
    if (path === '/voice/ai-ended') {
      return body.get('CallStatus') === 'completed'
        ? response()
        : announce('The language stream has ended.');
    }
    if (path === '/voice/mode' && digits === '2') {
      return announceHuman();
    }
    if (path === '/voice/mode' && attempt >= MAX_ATTEMPTS && digits !== '1') {
      return announceHuman();
    }
    if (path === '/voice/select') {
      const entry = findByDigits(menu, digits);
      if (entry !== undefined && query.get('v') === menu.version) {
        return mode === 'ai' ? announceAi(entry) : announceHuman();
      }
      if (attempt >= MAX_ATTEMPTS) {
        return announceHuman();
      }
    }
  }

  switch (path) {
    case '/voice/incoming':
      return modeMenu(1);

    case '/voice/org/incoming': {
      grant = undefined;
      const listed = ctx.companies?.byTwilioNumber(body.get('To'));
      return listed === undefined
        ? orgNumberPrompt(1, WELCOME)
        : companyLine(listed);
    }

    case '/voice/org/number': {
      grant = undefined;
      const orgNumber = /^\d{2,5}$/.test(digits ?? '') ? Number(digits) : 0;
      if (orgNumber >= 10) {
        return codePrompt(orgNumber, attempt);
      }
      return attempt >= MAX_ATTEMPTS
        ? goodbye(
            'org-id-unreadable',
            'Sorry, we could not read your organization ID.',
          )
        : orgNumberPrompt(attempt + 1, [
            'org-id-invalid',
            'Sorry, that is not a valid organization ID.',
          ]);
    }

    case '/voice/org/code':
      grant = undefined;
      return checkCode();

    case '/voice/mode':
      if (digits === '1' || digits === '2') {
        // A company may list the human first (humanFirst): 1 human, 2 AI.
        const wantsAi = digits === (company()?.humanFirst === true ? '2' : '1');
        if (menu.entries.length === 0) {
          return human(undefined, wantsAi ? speak(AI_NOT_AVAILABLE) : []);
        }
        return wantsAi ? languageMenu('ai', 1) : chooseHuman(1);
      }
      if (attempt >= MAX_ATTEMPTS) {
        return orgLine() ? noChoice() : human(undefined);
      }
      return modeMenu(attempt + 1);

    case '/voice/select': {
      if (menu.entries.length === 0) {
        return human(undefined);
      }
      if (query.get('v') !== menu.version) {
        // The menu changed since it was read out; read the current one.
        return languageMenu(mode, attempt);
      }
      const entry = findByDigits(menu, digits);
      if (entry === undefined) {
        if (attempt >= MAX_ATTEMPTS) {
          return orgLine() ? noChoice() : human(undefined);
        }
        return languageMenu(mode, attempt + 1);
      }
      return mode === 'ai' ? aiOrHuman(entry) : human(entry);
    }

    case '/voice/ai':
      // Reached from the "try AI instead" offer after a failed human dial.
      if (digits !== '1' || !ctx.aiAvailable || !canAi()) {
        return response(...speak(GOODBYE), element('Hangup'));
      }
      if (language === undefined) {
        // A company's own interpreter line is dialed with no language, so
        // the caller picks one now.
        return menu.entries.length === 0
          ? response(...speak(GOODBYE), element('Hangup'))
          : languageMenu('ai', 1);
      }
      return ai(language);

    case '/voice/ai-ended':
      await endLeg('AI');
      // The caller hanging up ends everything; any other end means the
      // gateway closed the stream: the caller pressed ###, or the backend
      // is unavailable or at capacity. This route cannot tell which, so the
      // gateway says "unavailable" itself before closing on a failure, and
      // either way counts as a switch.
      if (body.get('CallStatus') === 'completed') {
        return response();
      }
      switches = Math.min(switches + 1, MAX_SWITCHES);
      return human(language);

    case '/voice/human-result':
      await endLeg('HUMAN');
      if (body.get('DialCallStatus') === 'completed') {
        return response(element('Hangup'));
      }
      return noInterpreter();

    case '/voice/relay-ended': {
      // The relay closed the caller's stream; relay.ts kept the reason.
      await endLeg('HUMAN');
      if (body.get('CallStatus') === 'completed') {
        return response();
      }
      const outcome = ctx.relayOutcome?.(callSid);
      log('relay.outcome', { outcome: outcome ?? 'unknown' });
      if (outcome === 'switch_to_ai' && canAi()) {
        switches = Math.min(switches + 1, MAX_SWITCHES);
        if (!ctx.aiAvailable || menu.entries.length === 0) {
          return response(
            ...speak(AI_NOT_AVAILABLE, GOODBYE),
            element('Hangup'),
          );
        }
        return languageMenu('ai', 1, [SWITCH_TO_AI]);
      }
      if (outcome === 'interpreter_ended' || outcome === 'time_limit') {
        return response(element('Hangup'));
      }
      // No answer, or a reason this instance doesn't know.
      return noInterpreter();
    }

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
          ...speak(
            language === undefined
              ? [
                  'whisper',
                  'FourPoints interpretation call. Press 1 to accept.',
                ]
              : [
                  `whisper-${clipKey(language.languageId)}`,
                  `FourPoints interpretation call for ${language.displayName}. Press 1 to accept.`,
                ],
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

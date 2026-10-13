/**
 * Everything the phone line says, as recorded clips. Mirrors the <Say> text
 * in apps/telephony/src/ivr.ts (see docs/ivr-prompts.md). Change a line here,
 * then `node pipeline.mjs generate <id>` — only clips whose text changed are
 * regenerated.
 *
 * `text` is what ships in the manifest (and what the caller hears);
 * `speak` overrides what is sent to ElevenLabs when the spelling trips it up.
 */

export const VOICE = {
  // Lauren B - Confident Outbound Sales SDR (chosen by the owner, 2026-10-13).
  voiceId: 'WqfqZq3UXPCD87IXHLnm',
  modelId: 'eleven_v4',
  settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: true },
  seed: 4242,
};

/**
 * Audition: the owner's chosen voices on eleven_v4, which understands audio
 * tags such as [short pause] (v2 would read them aloud).
 */
export const AUDITION = {
  text: 'Welcome to FourPoints interpretation. [short pause] For an AI interpreter, press 1. [upward inflection] For a human interpreter, press 2.',
  modelId: 'eleven_v4',
  settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: true },
  voices: {
    'belle-b': 'aKw9UnnjRq5scbeeGI7Z',
    'lauren-b': 'WqfqZq3UXPCD87IXHLnm',
  },
};

/**
 * Phone menu order = FourPoints registry order (apps/realtime/src/languages.ts),
 * en-US (clinician) and text-only languages excluded. Names are the spoken
 * form (region dropped), as languages.ts `spokenName` does. If
 * MENU_LANGUAGE_ORDER changes in production, change this list to match:
 * the digit in each `language-option-*` clip depends on it.
 *
 * `connected` is the AI greeting in the caller's language, spoken right after
 * the English one in the same voice. Drafted by Claude (2026-10-13) — have a
 * native speaker check each before real patient calls.
 */
export const LANGUAGES = [
  {
    id: 'es-US',
    name: 'Spanish',
    code: 'es',
    connected:
      'Está conectado al intérprete de español con inteligencia artificial. Por favor, hablen de uno en uno. Presione la tecla asterisco cuando termine.',
  },
  {
    id: 'fr-FR',
    name: 'French',
    code: 'fr',
    connected:
      "Vous êtes connecté à l'interprète IA pour le français. Veuillez parler chacun à votre tour. Appuyez sur la touche étoile lorsque vous avez terminé.",
  },
  {
    id: 'de-DE',
    name: 'German',
    code: 'de',
    connected:
      'Sie sind mit dem KI-Dolmetscher für Deutsch verbunden. Bitte sprechen Sie nacheinander. Drücken Sie die Sterntaste, wenn Sie fertig sind.',
  },
  {
    id: 'it-IT',
    name: 'Italian',
    code: 'it',
    connected:
      "Siete collegati all'interprete IA per l'italiano. Per favore, parlate uno alla volta. Premete il tasto asterisco quando avete finito.",
  },
  {
    id: 'pt-BR',
    name: 'Portuguese',
    code: 'pt',
    connected:
      'Você está conectado ao intérprete de português com inteligência artificial. Por favor, falem um de cada vez. Pressione a tecla asterisco quando terminar.',
  },
  {
    id: 'hi-IN',
    name: 'Hindi',
    code: 'hi',
    connected:
      'आप हिंदी एआई दुभाषिए से जुड़ गए हैं। कृपया एक समय में एक ही व्यक्ति बोलें। बोलना समाप्त होने पर स्टार बटन दबाएँ।',
  },
  {
    id: 'ja-JP',
    name: 'Japanese',
    code: 'ja',
    connected:
      '日本語のAI通訳に接続されました。お一人ずつお話しください。話し終わったら、こめじるしボタンを押してください。',
  },
  {
    id: 'ko-KR',
    name: 'Korean',
    code: 'ko',
    connected:
      '한국어 AI 통역사에 연결되었습니다. 한 번에 한 분씩 말씀해 주세요. 말씀이 끝나면 별표를 눌러 주세요.',
  },
  {
    id: 'zh-CN',
    name: 'Mandarin Chinese',
    code: 'zh',
    connected:
      '您已接通普通话人工智能口译员。请一次只由一个人讲话。讲完后，请按星号键。',
  },
  {
    id: 'ar-AE',
    name: 'Arabic',
    code: 'ar',
    connected:
      'أنت متصل الآن بالمترجم الفوري بالذكاء الاصطناعي للغة العربية. يُرجى أن يتحدث شخص واحد في كل مرة. اضغط على زر النجمة عند الانتهاء.',
  },
];

const FP = { text: 'FourPoints', speak: 'Four Points' };
// `speak` may carry eleven_v4 audio tags ([short pause] …); `text` never does.
const line = (id, group, text, speak = text) => ({
  id,
  group,
  text,
  speak: speak.replaceAll(FP.text, FP.speak),
});

const FIXED = [
  // Opening and the AI / human menu
  line('welcome', 'opening', 'Welcome to FourPoints interpretation.'),
  line('thank-you', 'opening', 'Thank you.'),
  line(
    'mode-menu',
    'opening',
    'For an AI interpreter, press 1. For a human interpreter, press 2.',
    'For an AI interpreter, press 1. [upward inflection] For a human interpreter, press 2.',
  ),
  line('retry-invalid', 'opening', 'Sorry, that was not a valid choice.'),
  line('retry-no-input', 'opening', 'You have not made a choice yet.'),
  // Language menu
  line('language-menu-intro', 'language-menu', 'Please choose a language.'),
  line('language-menu-pound', 'language-menu', 'Then press pound.'),
  // AI interpreter
  line(
    'ai-not-available',
    'ai',
    'The AI interpreter is not available right now.',
  ),
  line('ai-unavailable', 'ai', 'The AI interpreter is unavailable.'),
  line(
    'ai-try-later',
    'ai',
    'The AI interpreter is not available right now. Please try again later. Goodbye.',
  ),
  // Human interpreter
  line(
    'human-connecting',
    'human',
    'Connecting you to a human interpreter. Please hold.',
  ),
  line(
    'human-not-included',
    'human',
    'A human interpreter is not included for your organization. Goodbye.',
  ),
  line(
    'no-interpreter',
    'human',
    'Sorry, no interpreter is available right now.',
  ),
  line('offer-ai', 'human', 'To use the AI interpreter instead, press 1.'),
  line(
    'no-interpreter-final',
    'human',
    'Sorry, no interpreter is available right now. Please try again later. Goodbye.',
  ),
  line('goodbye', 'human', 'Goodbye.'),
  line(
    'whisper',
    'whisper',
    'FourPoints interpretation call. Press 1 to accept.',
  ),
  // Organization line
  line(
    'org-id-prompt',
    'org',
    'Please enter your organization ID, then press pound.',
  ),
  line('org-id-invalid', 'org', 'Sorry, that is not a valid organization ID.'),
  line(
    'org-id-unreadable',
    'org',
    'Sorry, we could not read your organization ID. Goodbye.',
  ),
  line(
    'code-prompt',
    'org',
    'Please enter your six digit access code, then press pound.',
  ),
  line(
    'code-not-recognized',
    'org',
    'Sorry, that organization ID or access code was not recognized.',
  ),
  line(
    'code-check-failed',
    'org',
    'Sorry, we cannot check your access code right now. Please call again in a few minutes. Goodbye.',
  ),
  line(
    'line-unavailable',
    'org',
    'This line is not available right now. Goodbye.',
  ),
  line(
    'org-not-available',
    'org',
    'Phone interpretation is not available for your organization right now. Please contact your administrator. Goodbye.',
  ),
  line(
    'quota-exhausted',
    'org',
    'Your organization has used all of its interpretation minutes for this month. Please contact your administrator. Goodbye.',
  ),
  line(
    'no-choice',
    'org',
    'We did not receive a choice. Please call again when you are ready. Goodbye.',
  ),
];

const PER_LANGUAGE = LANGUAGES.flatMap(({ id, name, code, connected }, i) => {
  const key = id.toLowerCase();
  return [
    // Same keys as apps/telephony/src/languages.ts menuDigits: up to ten
    // languages are one key each, the tenth on 0.
    line(
      `language-option-${key}`,
      'language-menu',
      `For ${name}, press ${LANGUAGES.length <= 10 ? (i + 1) % 10 : i + 1}.`,
    ),
    // English, then the same in the caller's language; one voice, two takes
    // (the second with its language code so it is pronounced natively).
    {
      id: `ai-connected-${key}`,
      group: 'ai',
      text: `You are connected to the ${name} AI Interpreter. Please speak one person at a time. Press star when you are done. ${connected}`,
      parts: [
        {
          speak: `You are connected to the ${name} AI Interpreter. Please speak one person at a time. Press star when you are done.`,
        },
        { speak: connected, languageCode: code },
      ],
    },
    line(
      `human-connecting-${key}`,
      'human',
      `Connecting you to a human interpreter for ${name}. Please hold.`,
    ),
    line(
      `whisper-${key}`,
      'whisper',
      `FourPoints interpretation call for ${name}. Press 1 to accept.`,
    ),
  ];
});

export const PROMPTS = [...FIXED, ...PER_LANGUAGE].map((p) => ({
  ...p,
  parts: p.parts ?? [{ speak: p.speak }],
}));

/** Silence between the parts of a multi-part clip. */
export const PART_GAP_MS = 450;

export const MUSIC = {
  id: 'hold-music',
  lengthMs: 32_000,
  /** Seconds of tail cross-faded into the head so the loop has no seam. */
  loopCrossfadeS: 2,
  prompt:
    'Calm, warm instrumental hold music for a healthcare phone line. Soft felt piano with gentle plucked acoustic guitar and a light warm pad. ' +
    'Around 80 BPM, major key, reassuring and unobtrusive. No drums, no bass drops, no vocals. Steady, even energy from start to finish with no intro and no ending, so it loops seamlessly.',
  /** Per-take prompt overrides (take letter → prompt). */
  takes: {
    // Owner asked for something more soothing than the first b (2026-10-13).
    b:
      'Very soft, slow and soothing ambient instrumental for a hospital phone hold line. Warm, gentle pads; sparse, slow felt piano notes with lots of space between them; ' +
      'a faint, soft string bed. Around 60 BPM, peaceful and comforting, quiet and even dynamics. No percussion, no pulsing bass, no vocals, no sudden changes. ' +
      'Unchanging, calm energy from start to finish with no intro and no ending, so it loops seamlessly.',
  },
};

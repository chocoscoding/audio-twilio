# IVR prompt script (pre-recorded audio)

Every line the phone line speaks, as recorded clips. **Generated and approved
in `ivr-audio/`** (ElevenLabs eleven_v4, voice Lauren B); `ivr-audio/script.mjs`
is now the source for the exact wording, and the gateway plays a clip only
when its text matches what `apps/telephony/src/ivr.ts` would say. This page is
the original script; see TELEPHONY-009 in the decision ledger.

## File format

- **WAV, 8 kHz, mono, 8-bit μ-law** (Twilio plays it with no conversion).
  MP3 also works but adds a decode step.
- No leading silence; keep trailing silence ≤ 150 ms. The gap between clips
  is controlled in code, not in the files.
- File name = the **ID** column + `.wav`, e.g. `mode-menu.wav`.
- Voice: keep one voice for everything. The AI translations use Polly Joanna,
  so Joanna keeps the call sounding like one person.

Clips marked **lead** are played immediately before another clip
(e.g. `retry-invalid` → `mode-menu`), so record them as their own sentence.

## 1. Opening and the AI / human menu

| ID               | Text                                                              | When                                                      |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `welcome`        | Welcome to FourPoints interpretation.                             | **lead** — first thing a caller hears                     |
| `thank-you`      | Thank you.                                                        | **lead** — organization line, after a valid access code   |
| `mode-menu`      | For an AI interpreter, press 1. For a human interpreter, press 2. | AI or human menu                                          |
| `retry-invalid`  | Sorry, that was not a valid choice.                               | **lead** — before a menu is repeated after a wrong key    |
| `retry-no-input` | You have not made a choice yet.                                   | **lead** — organization line, menu repeated after silence |

## 2. Language menu

| ID                    | Text                      | When                                             |
| --------------------- | ------------------------- | ------------------------------------------------ |
| `language-menu-intro` | Please choose a language. | start of the language menu                       |
| `language-menu-pound` | Then press pound.         | end of the menu, only if there are 10+ languages |

Then **one clip per language, per menu position**. The digit is tied to the
language's position in the menu, so pin the order with `MENU_LANGUAGE_ORDER`
and re-record if it changes. (Code change planned: every option says
"For X, press N." — today only the first one says "For".)

| ID                     | Text                       |
| ---------------------- | -------------------------- |
| `language-option-<id>` | For <Language>, press <N>. |

Example with the current presentation list (`Spanish, Mandarin, Arabic, French, Portuguese`):

| ID                           | Text                     |
| ---------------------------- | ------------------------ |
| `language-option-spanish`    | For Spanish, press 1.    |
| `language-option-mandarin`   | For Mandarin, press 2.   |
| `language-option-arabic`     | For Arabic, press 3.     |
| `language-option-french`     | For French, press 4.     |
| `language-option-portuguese` | For Portuguese, press 5. |

> The live menu comes from the FourPoints language registry (up to 14
> languages, clinician language excluded). Confirm the production list and
> order before recording.

## 3. AI interpreter

| ID                  | Text                                                                                                                            | When                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `ai-connected-<id>` | You are connected to the FourPoints <Language> AI Interpreter. Please speak one person at a time. Press star when you are done. | one per language, right before the AI starts        |
| `ai-not-available`  | The AI interpreter is not available right now.                                                                                  | **lead** — before transfer to a human               |
| `ai-unavailable`    | The AI interpreter is unavailable.                                                                                              | **lead** — AI dropped mid-call, transfer to a human |
| `ai-try-later`      | The AI interpreter is not available right now. Please try again later. Goodbye.                                                 | organization line, no languages, no human access    |

## 4. Human interpreter

| ID                      | Text                                                                           | When                                          |
| ----------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| `human-connecting`      | Connecting you to a human interpreter. Please hold.                            | no language chosen                            |
| `human-connecting-<id>` | Connecting you to a human interpreter for <Language>. Please hold.             | one per language                              |
| `human-not-included`    | A human interpreter is not included for your organization. Goodbye.            | organization line, no human access            |
| `no-interpreter`        | Sorry, no interpreter is available right now.                                  | **lead** — nobody answered                    |
| `offer-ai`              | To use the AI interpreter instead, press 1.                                    | after `no-interpreter`                        |
| `no-interpreter-final`  | Sorry, no interpreter is available right now. Please try again later. Goodbye. | nobody answered, no AI option                 |
| `goodbye`               | Goodbye.                                                                       | after `offer-ai` with no key, and other exits |

### Heard only by the interpreter (whisper)

| ID             | Text                                                              |
| -------------- | ----------------------------------------------------------------- |
| `whisper`      | FourPoints interpretation call. Press 1 to accept.                |
| `whisper-<id>` | FourPoints interpretation call for <Language>. Press 1 to accept. |

## 5. Organization line (organization ID + access code)

| ID                    | Text                                                                                                                     | When                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `org-id-prompt`       | Please enter your organization ID, then press pound.                                                                     | after `welcome`, or after a retry lead                      |
| `org-id-invalid`      | Sorry, that is not a valid organization ID.                                                                              | **lead** → `org-id-prompt`                                  |
| `org-id-unreadable`   | Sorry, we could not read your organization ID. Goodbye.                                                                  | third bad organization ID                                   |
| `code-prompt`         | Please enter your six digit access code, then press pound.                                                               | after a valid organization ID                               |
| `code-not-recognized` | Sorry, that organization ID or access code was not recognized.                                                           | **lead** → `org-id-prompt`, or + `goodbye` on the third try |
| `code-check-failed`   | Sorry, we cannot check your access code right now. Please call again in a few minutes. Goodbye.                          | FourPoints did not answer                                   |
| `line-unavailable`    | This line is not available right now. Goodbye.                                                                           | gateway has no FourPoints access                            |
| `org-not-available`   | Phone interpretation is not available for your organization right now. Please contact your administrator. Goodbye.       | organization paused / no phone access                       |
| `quota-exhausted`     | Your organization has used all of its interpretation minutes for this month. Please contact your administrator. Goodbye. | out of minutes                                              |
| `no-choice`           | We did not receive a choice. Please call again when you are ready. Goodbye.                                              | third menu with no key pressed                              |

## 6. Presentation mode only (demo line, skip for production)

| ID                       | Text                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo-routed-human`      | You are being routed to a human interpreter.                                                                                                      |
| `demo-routed-human-hold` | You are being routed to a human interpreter. Please hold.                                                                                         |
| `demo-stream-ended`      | The language stream has ended.                                                                                                                    |
| `demo-thanks`            | Thank you for calling FourPoints. Goodbye.                                                                                                        |
| `demo-ai-<id>`           | You are connected to the AI interpreter. This is the <Language> language stream. After the beep, say something, and you will hear it played back. |

## 7. Hold music (optional)

| ID           | What                                                                    | When                                                                                      |
| ------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `hold-music` | Instrumental loop, 20–30 s, seamless loop point, no vocals, no fade-out | AI path: after `ai-connected-<id>` if FourPoints is not ready yet; stops the moment it is |

- Same file format as the prompts (8 kHz mono μ-law WAV). Check it sounds
  fine after conversion: phone audio drops bass and everything above
  ~3.4 kHz, so soft piano / plucked / light synth works; bass-heavy or busy
  tracks turn to mush.
- Quieter than the voice prompts (about 6 dB lower) so the first tone and the
  translation don't feel loud by comparison.
- No vocals: the caller would think someone is talking to them.
- If it is AI-generated (Suno, Udio, …), use a plan that grants commercial
  rights; it will play to every caller.

## Not speech — nothing to record

The in-call tones (low tone = clinician, high tone = patient, double beep =
"please repeat") are generated in `apps/telephony/src/audio.ts`.

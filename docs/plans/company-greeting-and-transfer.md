# Plan: company numbers, company greeting, and ### to switch between AI and human

Status: **DRAFT for owner review. Nothing is built yet.** (2026-10-23)

## What was asked

1. **Company numbers.** A company gives us the phone number its customers
   call. Calls on that number get the company's intro instead of
   "FourPoints".
2. **Access on a company number.** If the company has an organization-wide
   access code, the caller enters it. If it has none, the caller goes
   straight in.
3. **The company's own human interpreters.** "Human" means the company's
   own OPI number: one number, no language menu. The OPI side sorts out the
   language itself.
4. **AI → human.** During an AI call, pressing `#` three times moves the
   caller to a human interpreter.
5. **Human → AI.** During a human call, pressing `#` three times moves the
   caller to the AI. There is no welcome and no AI/human menu; the caller
   goes straight to the language menu ("For Spanish, press 1 …"). The OPI
   side can't tell us which language was being used, so the caller picks it.

## Owner decisions (2026-10-23)

- "Customer number" means **phone numbers** of the company's own.
- **Change the source of truth:** an organization may have a dedicated number.
  On it, an organization-wide access code is asked for only if the
  organization has one. With no code, the caller goes straight in.
- The owner adds each company's numbers and its welcome recording to the
  code. There is no admin screen for now.
- Human interpretation for these companies is **their own OPI number**, with
  no language menu.
- **Human → AI goes to the language menu.**
- **Approved:** during human calls, a copy of the caller's side of the audio
  goes to the gateway so it can hear `###` (conflict 3 in the earlier draft).
  The gateway only listens for `#` tones in memory. The audio is never stored
  and never sent to FourPoints.
- **Minutes:** time on a company's OPI number counts against its monthly
  minutes, the same as human calls do today.
- **Clip names don't need to be hidden** (conflict 4 in the earlier draft). A
  company welcome is simply `welcome-org-<orgNumber>`.
- **The switch key is `###` in both directions.** `000` was considered and
  rejected: in a human call the caller is using the company's OPI menu, where
  account numbers, PINs and "press 0 for an operator" would set off `000` by
  accident.

## Still open

1. **If the live test (Part 4) shows `###` can't be heard during a human
   call**, I'll come back to you. Using `*` instead was offered, but you
   haven't approved it.
2. **Should callers be told about `###`** in the greetings? Not planned. It
   would mean re-recording 10 `ai-connected-*` clips.

---

## How the code works today

- **Only one line the caller hears says "FourPoints":** `welcome`
  ([ivr.ts:49](../../apps/telephony/src/ivr.ts#L49)). The interpreter's
  whisper and the presentation-mode lines also say it. Neither changes.
- **The organization line** plays the welcome, asks for the organization ID
  ([ivr.ts:617](../../apps/telephony/src/ivr.ts#L617)), then the access code,
  then says "Thank you." and plays the menu.
- **Access codes** come in two kinds. Each organization has at most one
  organization-wide code (`org_access_code`: code and paused), and each person
  can have their own code. `app_resolve_phone_access(org_number, code)` accepts
  either one. An organization can have no organization-wide code.
- **Onboarding already asks** `telephone_number_option` (`SHARED_TOLL_FREE |
DEDICATED | ADVISE`) and `access_code_entry` (`CALLER_ENTERS_CODE |
DEDICATED_NUMBER_IDENTIFIES`)
  ([onboarding.ts:69](../../../FourPoints/packages/db-schema/src/schema/onboarding.ts#L69)).
  The phone line uses neither.
- **Human interpreters** come from one `HUMAN_INTERPRETER_NUMBERS` setting,
  with numbers per language, for every call. Each interpreter hears "Press 1
  to accept" before being connected, so a voicemail can't pick up the call.
- **In an AI call, keypresses arrive as Twilio `dtmf` events.** Only `*` does
  anything ([floor.ts:126](../../apps/telephony/src/floor.ts#L126)).
- **In a human call the gateway is not in the call.** Twilio `<Dial>` connects
  the caller and the interpreter directly, and doesn't report keypresses
  (only `*` with `hangupOnStar`).

---

## Part 0 — Source-of-truth changes (written first, after your go)

**SoT §6, "Telephony tenancy model"**
([source of truth:317](../../../FourPoints/docs/architecture/commercial-architecture-source-of-truth.md#L317)).
Proposed replacement for the bullets:

- FourPoints owns the Twilio account. An organization uses either the shared
  FourPoints number or a **dedicated number** of its own: its number forwarded
  to a Twilio number FourPoints assigns to it, or ported into FourPoints'
  Twilio account.
- **Shared number:** the organization is identified by its organization number
  and access code, as today.
- **Dedicated number:** the number the call arrives on (Twilio `To`, covered
  by the Twilio signature) identifies the organization.
  - If the organization has an organization-wide access code, **active or
    paused**, the caller must enter a valid access code (the organization's
    code or a person's code). A wrong code is handled as today.
  - If it has **no** organization-wide code, the call goes straight in.
    Anyone who knows the number can then use the organization's minutes; the
    organization accepts this when it chooses no code.
  - Either way, FourPoints checks organization status, phone access,
    AI/human entitlements and minutes left on every call, and refuses
    (fail closed) if anything is missing.
- Caller ANI/caller ID is still not proof of who the organization is.
- An organization's human interpretation may be **its own interpreter line
  (OPI)** instead of FourPoints' interpreters.

**SoT, AI ↔ human switching**
([source of truth:72](../../../FourPoints/docs/architecture/commercial-architecture-source-of-truth.md#L72)).
Add: "On the phone, a caller may switch between AI and human by pressing `#`
three times, where the organization has both. The caller hears the switch."

**Guardrail**
([guardrail:132](../../../FourPoints/docs/engineering/fourpoints-commercial-engineering-guardrail.md#L132)).
"Dedicated tenant DIDs or Twilio subaccounts remain future options" becomes
"Dedicated numbers are allowed (SoT §6); Twilio subaccounts remain a future
option."

**Ledger:** one FourPoints decision-ledger entry for the tenancy change. Also
telephony entries TELEPHONY-010 and later: the company list, OPI numbers,
`###`, and the caller-audio copy.

Points to know about these changes:

- **A paused code still counts as a code.** Pausing must never open a line.
- **Not having a code is what opens a dedicated line.** If staff remove the
  organization-wide code from a company that has a dedicated number, anyone
  can call in. The admin console should warn about this later.
- **The onboarding answer `access_code_entry` doesn't drive the phone line.**
  Whether a code exists does. Staff should create or skip the
  organization-wide code to match what the company chose.

---

## Part 1 — Company numbers and greeting

### What a caller hears on a company number

1. **"Welcome to <Company>."** (your recording).
2. **If the company has an organization-wide code:** "Please enter your six
   digit access code, then press pound." (existing clip). There is no
   organization ID prompt, because the number already tells us who it is.
   **If it has none:** this step is skipped.
3. Then:

| Company has  | Caller hears next                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI and human | "For an AI interpreter, press 1. For a human interpreter, press 2." **1** → language menu → AI. **2** → "Connecting you to a human interpreter. Please hold." → their OPI number, no language menu |
| AI only      | Language menu → AI                                                                                                                                                                                 |
| Human only   | "Connecting you to a human interpreter. Please hold." → their OPI number                                                                                                                           |

Calls on the shared FourPoints numbers don't change.

### How a company's number reaches us

1. **Forwarded** (the number stays with the company's phone company). Twilio
   sees the call arriving on **our** number, and passes on the company's
   number only if the caller's phone company sends it, which Twilio says not
   all do. So **each company forwards to a Twilio number of its own that we
   buy for it** (about $1–2 a month), and we recognize the company by that
   number.
2. **Ported** into our Twilio account. The call arrives on the company's own
   number, and we recognize it directly.

Setting up a company:

1. Buy the Twilio number, or start the port.
2. Point its **A call comes in** webhook at `/voice/org/incoming`.
3. Add the company to the code list.
4. If forwarding: the company turns on forwarding to the Twilio number.
5. Record the welcome and import it.

### The code list (you fill it in)

New file `apps/telephony/src/companies.ts`:

```ts
{
  orgNumber: 123,
  // Must belong to orgNumber; FourPoints checks both, so a typo fails closed.
  organizationId: '3f1c…',
  companyName: 'Acme Health',
  lines: [
    {
      twilioNumber: '+15557654321', // the number the call arrives on in Twilio
      // Forwarded numbers only: the company's own number, as a record.
      publicNumber: '+18005551234',
    },
  ],
  // Their OPI line. Without it, human calls go to FourPoints' interpreters.
  humanNumber: '+18885550000',
}
```

- The welcome clip is always `welcome-org-<orgNumber>`, and its text is always
  `Welcome to <companyName>.`. Until you record it, Twilio reads
  that same sentence aloud.
- The gateway refuses to start if a Twilio number appears twice, if any number
  isn't in `+1…` (E.164) form, or if an `orgNumber` appears twice.
- The IVR reads the list through a small `CompanySource` interface. Later, a
  version backed by the FourPoints database replaces it, and `ivr.ts` doesn't
  change.
- Through the whole call the gateway keeps the `orgNumber` in the signed URLs
  (like the rest of the call's state), so later steps know to use the
  company's OPI number.

**OPI numbers skip the "Press 1 to accept" check.** An OPI line answers with
its own menu or queue, and nobody there would press 1, so the check would hang
up every call. The caller hears the OPI menu directly and goes through it, the
same as calling the OPI number from their own phone.

### FourPoints side (new; schema draft for your review before any migration)

- **New database function** `app_resolve_phone_line(org_number,
organization_id)` (migration 0031). It runs the same checks as the code check
  (organization exists and both IDs match, ACTIVE, phone access, minutes left)
  and returns:
  - `CODE_REQUIRED` when the organization has an organization-wide code
    (active or paused);
  - otherwise `OK` with AI/human entitlements and minutes left, and no person.

  No tables or columns change. Ownership and grants are the same as
  `app_resolve_phone_access`.

- **New API route** `POST /internal/phone/line`, in
  [phone.ts](../../../FourPoints/apps/api/src/routes/phone.ts), with the same
  phone machine scope and time limit as `/internal/phone/resolve`.
- Entering a code on a company number reuses `/internal/phone/resolve`.
- Calls without a code count under the company, not under a person.

### Your recording

```bash
node ivr-audio/pipeline.mjs import welcome-org-123 ~/Desktop/acme.m4a "Welcome to Acme Health."
```

This gives your file the same treatment as the other clips (silence trimmed,
−19 LUFS, 8 kHz μ-law). It puts the clip in `ivr-audio/review/index.html` so
you can listen, and `node ivr-audio/pipeline.mjs approve welcome-org-123`
ships it. Any file ffmpeg reads works (m4a, mp3, wav). The text must match
the code exactly, or the gateway falls back to reading it aloud.

### Later: database and S3 (not in this plan)

The code list becomes a table, for example `organization_phone_line`
(twilio_number unique, public_number for forwarded numbers, organization_id, `FORWARDED | PORTED`,
human_number). Recordings go into a private, encrypted S3 bucket and are
uploaded in the admin web app behind the same Cognito-via-ALB login. The
gateway fetches and caches them and serves them for `<Play>`. The schema gets
your review first.

---

## Part 2 — `###` during AI → human

1. The caller presses `#` `#` `#` within 5 seconds, with no other key in
   between. One or two `#` do nothing, and `*` works as before.
2. The gateway's keypress handler
   ([call.ts:425](../../apps/telephony/src/call.ts#L425)) drops any
   half-recorded turn, so the key tones are never translated, and closes the
   stream.
3. Twilio continues at `/voice/ai-ended`, which carries the call's state. The
   AI usage leg ends and the human leg starts.
4. **Company with an OPI number:** "Connecting you to a human interpreter.
   Please hold." → their OPI number.
   **FourPoints' interpreters:** "Connecting you to a human interpreter for
   Spanish. Please hold." → the Spanish interpreters, as today.

The organization never goes into the media stream (a test enforces this). The
TwiML adds only a yes/no `transfer` flag, set when human is allowed. Without
it, `###` is ignored.

**One change to existing behavior.** `/voice/ai-ended` can't tell "the caller
asked" from "the AI broke". So it stops saying "The AI interpreter is
unavailable." itself; the gateway plays that line into the stream before it
closes when the AI fails.

**No new recording:** both "Connecting you…" lines already exist.

---

## Part 3 — `###` during human → AI

1. Before connecting the human, the TwiML starts a one-way copy of **the
   caller's side only** to a new gateway route, `/watch`. This happens only
   when the company has AI.
2. `/watch` runs the same Twilio signature check as `/media` and listens for
   the `#` tone (941 Hz + 1477 Hz). The audio is checked and thrown away. The
   OPI interpreter's side isn't in the copy, so the interpreter pressing `#`
   does nothing.
3. On `###`, the gateway uses the Twilio REST API: the OPI leg hears "The
   caller has switched to the AI interpreter. Goodbye." and is hung up.
4. That ends the human connection. Twilio calls `/voice/human-result` with the
   call's state. Twilio leaves out `DialCallDuration` when the other leg was
   redirected, which tells us it was `###` and not the interpreter hanging up.
   The human usage leg ends.
5. The caller hears **"Switching you to the AI interpreter."**, then the
   language menu: "Please choose a language. For Spanish, press 1 …". They
   pick one and hear the existing greeting ("You are connected to the Spanish
   AI Interpreter…"), and the AI call runs as normal.

**OPI menus.** If the OPI number's own menu ever asks for `#` three times in a
row within 5 seconds, that would switch to AI. Typing an account number and
then `#` does not.

**Needs:** a Twilio API key on the gateway, stored where the Auth Token is now,
and outbound access to `api.twilio.com`.

## Part 4 — Live test before building Part 3 (about half a day)

On a real, upgraded Twilio number, check:

- **Are the `#` tones actually in the copied audio?** Some phone networks send
  keypresses separately from the audio, and Twilio may strip them out. If they
  aren't there, I come back to you (open question 1).
- **Does redirecting the OPI leg** end the human connection, with `completed`
  and no `DialCallDuration`?
- **Does a real OPI line work when connected straight through**, with no
  "Press 1 to accept"?

---

## Recordings

| Clip                         | Text                                                    | Who makes it                                          |
| ---------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `welcome-org-<n>`            | Welcome to <Company>.                                   | **you**, one per company                              |
| `human-connecting`           | Connecting you to a human interpreter. Please hold.     | already recorded                                      |
| `switch-to-ai` (new)         | Switching you to the AI interpreter.                    | generated in the same voice (`pipeline.mjs generate`) |
| `interpreter-released` (new) | The caller has switched to the AI interpreter. Goodbye. | generated (the OPI interpreter hears it)              |

There's no need for "Connecting you to the AI interpreter, please hold". The
AI greeting already says "You are connected…", and hold music covers any wait.

## Limits

- At most **3 switches per call**; after that `###` is ignored. This stops
  endless back-and-forth and limits how many times the minute cap can be
  reset, since each human leg's time limit uses the minutes left at the start
  of the call.
- What the company has is respected: AI-only means no `###` to human, and
  human-only means no audio copy.
- Presentation mode doesn't change.

## Order of work (each step built, tested and reported before the next)

1. **Source-of-truth, guardrail and ledger text** (Part 0).
2. **Schema draft for `app_resolve_phone_line`** → your review → migration 0031
   and `/internal/phone/line`.
3. **Gateway:** company list, company number flow (welcome, then code or
   straight in), OPI number, and the `import` command.
4. **`###` AI → human.**
5. **Live test** (Part 4), then report.
6. **`###` human → AI.**
7. **Docs:** `docs/ivr-prompts.md`, the README, and the steps for setting up a
   company.

## Files

| File                                                                                          | Change                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| FourPoints `docs/architecture/commercial-architecture-source-of-truth.md`                     | §6 and the switching rule                                                                    |
| FourPoints `docs/engineering/fourpoints-commercial-engineering-guardrail.md`                  | dedicated numbers allowed                                                                    |
| FourPoints `docs/architecture/decision-ledger.md`                                             | tenancy decision                                                                             |
| FourPoints `docs/architecture/schema-drafts/0031-…md`, `packages/tenant-db/migrations/0031_…` | `app_resolve_phone_line`                                                                     |
| FourPoints `apps/api/src/routes/phone.ts`                                                     | `/internal/phone/line`                                                                       |
| `apps/telephony/src/companies.ts` (new)                                                       | company list and `CompanySource`                                                             |
| `apps/telephony/src/access.ts`                                                                | `line()` call                                                                                |
| `apps/telephony/src/ivr.ts`                                                                   | company number flow, OPI dial, `transfer` flag, `ai-ended` lead, switch branch, switch count |
| `apps/telephony/src/call.ts`                                                                  | `###` → close; play `ai-unavailable` before a failure close                                  |
| `apps/telephony/src/dtmf-tone.ts`, `watch.ts`, `twilio-rest.ts` (new)                         | Part 3                                                                                       |
| `apps/telephony/src/server.ts`, `config.ts`                                                   | `/watch` route; Twilio API key                                                               |
| `ivr-audio/pipeline.mjs`, `ivr-audio/script.mjs`                                              | `import` command; two new lines                                                              |

## Tests

- **Company number:**
  - With a code: welcome, code prompt, no organization ID prompt; a wrong code
    gets the usual retries; a person's code works.
  - A paused code still asks for a code.
  - No code: straight to the menu.
  - A number that isn't listed: shared line, as today.
  - `organizationId` doesn't match `orgNumber`: refused.
  - Company not ACTIVE, out of minutes, or no phone access: the usual
    goodbyes.
  - Missing recording: the sentence is read aloud.
  - Bad list (duplicate number, bad format): refuses to start.
- **OPI:** human goes to the company's number with no language menu and no
  "Press 1 to accept". A company without `humanNumber` uses FourPoints'
  interpreters.
- **AI → human:** `# # #` closes the stream. One or two `#`, too slow, and
  `#*#` do nothing. No `transfer` flag means ignored. A half-recorded turn is
  never translated. The OPI or same-language interpreter is dialed.
- **Human → AI:** the tone detector on generated `#` tones, other keys, speech
  and noise. `human-result` with and without `DialCallDuration`. "Switching
  you to the AI interpreter." followed by the language menu. The switch limit.
- **FourPoints:** `app_resolve_phone_line` for each outcome, both IDs
  mismatched, and a paused code. The route's auth and time limit.
- Every new external call (FourPoints `/line`, Twilio REST) has a time limit
  and a test for when it fails.

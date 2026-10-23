# FourPoints telephony (staging workspace)

`@fourpoints/telephony` turns a Twilio phone number into a FourPoints
interpretation line: callers press **1** for the AI interpreter or **2** for a
human, choose a language, and talk.

This workspace mirrors the FourPoints monorepo so `apps/telephony` moves in
unchanged when write access is granted.

**Deploying? Start with [DEPLOY.md](DEPLOY.md).**

## How a call works

- **Shared FourPoints number** — "Welcome to FourPoints interpretation.",
  then (on the organization line) organization ID and access code, then
  **1** AI / **2** human, then a language. AI calls take turns by tones;
  human calls ring FourPoints' interpreters, who press 1 to accept.
- **A company's own number** — the number the call arrives on identifies
  the company. The caller hears "Welcome to <Company>." and,
  only if the company has an organization-wide access code (active or
  paused), enters a code; with no code the call goes straight in. Human
  calls can go to the company's own interpreter line (OPI): no language
  menu, no "Press 1 to accept", minutes still count.
- **`###` switches between AI and human** in either direction (at most 3
  times per call). AI → human closes the AI stream and connects a human.
  Human → AI listens for `#` tones on a one-way copy of the caller's audio
  (in memory only, never stored or sent to FourPoints), releases the
  interpreter ("The caller has switched to the AI interpreter. Goodbye."),
  and gives the caller "Switching you to the AI interpreter." and the
  language menu. Human → AI still needs a live test.

Details: [apps/telephony/README.md](apps/telephony/README.md#how-a-call-works).

## Set up a company number

1. Buy a Twilio number for the company (they forward their number to it), or
   port their number into the FourPoints Twilio account.
2. Point its **A call comes in** webhook at `/voice/org/incoming`.
3. Add the company to `apps/telephony/src/companies.ts`: `orgNumber`,
   `organizationId`, `companyName`, `lines: [{ twilioNumber }]` (plus `publicNumber` only for a forwarded
   number),
   and optionally `humanNumber` (their OPI line).
4. If forwarding, the company turns on forwarding to the Twilio number.
5. Record the welcome (the entry's optional `welcome`, or "Welcome to
   <companyName>.") and import it:
   `node ivr-audio/pipeline.mjs import welcome-org-<orgNumber> <file> "<text>"`,
   listen in `ivr-audio/review/index.html`, then
   `node ivr-audio/pipeline.mjs approve welcome-org-<orgNumber>`.

Human → AI `###` also needs `TWILIO_ACCOUNT_CLIENT_SID` / `TWILIO_ACCOUNT_CLIENT_SECRET` on
the gateway and outbound access to `api.twilio.com`. Full steps:
[apps/telephony/README.md](apps/telephony/README.md#set-up-a-company-number).

| Path                                | What it is                                                       |
| ----------------------------------- | ---------------------------------------------------------------- |
| `apps/telephony/`                   | The gateway — all new code. **Start with its README.**           |
| `packages/protocol/`                | Byte-identical copy of the FourPoints wire protocol. Never edit. |
| `docs/fourpoints-exposure.md`       | The only change deployed FourPoints needs (infrastructure only). |
| `docs/decision-ledger-telephony.md` | Decisions, in FourPoints Decision Ledger format.                 |
| `docs/migration.md`                 | How to move the app into the FourPoints monorepo.                |

```bash
npm install
npm run build
npm test
npm run lint
npm run check:protocol-sync   # vendored protocol still matches ../FourPoints
```

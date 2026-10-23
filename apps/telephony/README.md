# @fourpoints/telephony

A phone front door for FourPoints. Twilio carries the audio; FourPoints does
all recognition, translation, quality gating and speech — unchanged.

```
Caller phone (clinician + patient on speakerphone)
   │ PSTN
Twilio number ──HTTPS webhooks──► gateway: IVR  (press 1 AI / 2 human → language)
   │                                  └─ human: <Dial> interpreter numbers (whisper screening)
   └─ <Connect><Stream> wss /media ─► gateway: media bridge (one per call)
        μ-law 8 kHz                      μ-law ⇄ PCM16, 8 ⇄ 16 kHz, VAD, floor control
                                           │ FourPoints protocol v1 (same as the browser)
                                           ▼
                             FourPoints realtime: Transcribe → Translate → quality gate → Polly
```

## How a call works

1. **IVR** — "For an AI interpreter, press 1. For a human interpreter, press 2."
   Then a language menu read from the FourPoints language registry (only
   languages FourPoints can hear and speak; up to 10 are one key each, the
   tenth on 0; 11–14 use two digits ending with `#`). Invalid input
   re-prompts three times, then reaches a human.
   Every line is a **recorded prompt** (`ivr-audio/`, one voice, served at
   `/prompts/<id>.wav` for `<Play>` and cached by Twilio), so nothing is
   synthesized during the call. A line whose clip is missing or no longer
   says exactly what the code would say falls back to `<Say>`.
2. **AI path** — Twilio opens a media stream to the gateway at once. The
   gateway plays the greeting (English, then the caller's language) while it
   opens one FourPoints session (`session.start` → `conversation.start`,
   clinician language = `CLINICIAN_LANGUAGE_ID`); if the session is still not
   ready 0.4 s after the greeting, hold music loops until it is, then stops
   instantly (`clear`) and the first tone plays.
3. **Taking turns** — a phone has no screen, so tones hand over the floor:
   **low tone** = clinician speaks, **high tone** = patient speaks, **double
   beep** = "not translated, please repeat". **Star** switches who speaks next.
   The gateway detects speech (`vad.ts`, the FourPoints browser VAD), streams
   the turn to FourPoints, and plays the translation back.
   **Who actually spoke** (FourPoints LANGID-001): the tone is only the
   expected speaker. FourPoints checks which of the two languages it hears;
   if the patient speaks twice in a row, the second turn is still translated
   from the patient's language, and the next tone goes to the clinician.
   Very short answers ("Sí", "Okay") are too short to check and keep the
   expected speaker, as before. `DETECT_SPEAKER_LANGUAGE=false` turns the
   check off.
4. **Human path, and every failure** — `<Dial>` rings the configured
   interpreters at once; each hears "FourPoints interpretation call for
   Spanish. Press 1 to accept" so voicemail cannot answer. If the AI stream
   fails (FourPoints down, gateway full), the caller hears "The AI
   interpreter is unavailable." and Twilio continues at `<Connect action>`
   to put them through to a human.
5. **Company numbers** — a call arriving on a Twilio number listed in
   `src/companies.ts` belongs to that company. The caller hears "Welcome to
   <Company> interpretation." (the company's recording, or `<Say>` until it
   is imported). There is no organization ID prompt: if the company has an
   organization-wide access code (active or paused), the caller enters an
   access code; if it has none, the call goes straight in. FourPoints still
   checks status, phone access, AI/human and minutes on every call. Then the
   usual menu (AI and human), or straight to the language menu (AI only), or
   straight to a human (human only). A company with its own interpreter
   line (OPI, `humanNumber`) has human calls go to that number with no
   language menu and no "Press 1 to accept"; its minutes still count.
6. **`###` switches between AI and human** (where the organization has
   both; at most 3 switches per call):
   - **AI → human:** `#` three times within 5 seconds closes the AI stream
     (a half-spoken turn is dropped, not translated) and the caller hears
     "Connecting you to a human interpreter… Please hold."
   - **Human → AI:** a human call to a company's own interpreter line is
     **relayed through the gateway** (`relay.ts`): the caller's call opens a
     two-way stream (`/relay`), the gateway rings the interpreter line with
     the Twilio REST API, that call opens a second stream (`/relay-leg`), and
     the gateway passes the audio between them unchanged, in memory only.
     The gateway therefore sees the caller's keys: on `###` the interpreter
     hears "The caller has switched to the AI interpreter. Goodbye." and is
     hung up; the caller hears "Switching you to the AI interpreter." and
     the language menu. Other keys are played to the interpreter line as
     tones, so its own menu still works. `HUMAN_RELAY=off` goes back to
     plain `<Dial>` (no `###` out of a human call). Calls to FourPoints'
     own interpreters still use `<Dial>`.
   - After the AI greeting, callers who can reach a human hear "To switch to
     a human interpreter, press pound three times."
   - `###` rather than `000`, because callers type account numbers, PINs and
     "0 for an operator" into OPI menus. One or two `#`, and `*`, work as
     before. The human → AI direction is subject to a live test (see Known
     limits).

## Echo — why there is no "Twilio AEC"

Twilio has no echo-cancellation setting for phone calls or Media Streams (it
exists only in its app SDKs). Echo is handled the way FourPoints already does
in the browser (decision SLICE9-003): **half-duplex**. While a cue or a
translation is playing, and for 300 ms after, caller audio is discarded, and
the VAD re-calibrates before listening again. The speakerphone's own echo
canceller does the rest. Consequence: nobody can interrupt a translation
(barge-in), same as the web app. Use a decent full-duplex speakerphone.

## Run it locally against FourPoints (no phone needed)

1. **FourPoints realtime** (needs `aws sso login --profile FourPoints-Dev`;
   makes billable AWS calls per turn):

   ```powershell
   cd C:\Users\ot\Desktop\WF\FourPoints
   npm install; npm run build
   $env:AWS_PROFILE='FourPoints-Dev'; $env:AWS_REGION='us-east-1'; npm run start:realtime
   ```

2. **Gateway**:

   ```powershell
   cd "C:\Users\ot\Desktop\WF\audio twilio"
   npm install; npm run build
   copy apps\telephony\.env.example apps\telephony\.env   # then edit it
   node --env-file=apps/telephony/.env apps/telephony/dist/index.js
   ```

3. **A synthetic test sentence** (Windows built-in voice, 16 kHz mono):

   ```powershell
   Add-Type -AssemblyName System.Speech
   $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
   $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
   $s.SetOutputToWaveFile("$PWD\speech-en.wav", $f); $s.Speak('I have had chest pain for two days.'); $s.Dispose()
   ```

4. **Fake call** — plays Twilio's part (signs the handshake with your `.env`
   token, streams the WAV, echoes playback marks):

   ```powershell
   node --env-file=apps/telephony/.env apps/telephony/dist/fake-twilio-call.js speech-en.wav --lang es-US --save translated.wav
   ```

   `fake call PASS` means FourPoints translated the sentence and the Spanish
   speech came back through the phone audio path. Use `--speaker patient` with
   a clip in the patient's language to test the other direction.

## Put it on a real phone number

1. **Twilio account** — sign up at twilio.com, verify email and mobile, enable
   2FA. **Upgrade the account**: trial accounts replace `<Stream>` and
   `<Dial><Number>` with a "not available on trial" message, so neither path
   works on a trial.
2. **Number** — Console → Phone Numbers → buy a number with **Voice**. Some
   countries need a regulatory bundle first.
3. **Host the gateway** — today on Helicarrier at
   `https://telephony.on.helicarrier.xyz` (`DEPLOY.md`); any host meeting the
   requirements below works.
4. **Point the number at it** — number → Voice Configuration → Configure with
   _Webhook_: **A call comes in** `https://phone.example.com/voice/incoming`
   (POST); optionally **Call status changes**
   `https://phone.example.com/voice/status`.
5. **Credentials** — Console → Account → API keys & tokens: put the Account SID
   and primary Auth Token in the gateway's secrets. Every webhook and media
   stream is rejected unless Twilio signed it with that token.
6. Leave **call recording off** (FourPoints stores no audio).
7. **Compliance** — real patient calls need a Twilio BAA on eligible products
   and FourPoints' approval; until then use synthetic scenarios only.
8. **Deployed FourPoints** — staging FourPoints accepts the gateway's machine
   login on `/ws/telephony`. The live gateway runs on Helicarrier and deploys
   on every push to `master`; see `DEPLOY.md`.

## Set up a company number

A company's own number gets its own welcome and, optionally, its own
interpreter line (TELEPHONY-010 to 013).

1. **Get the number into Twilio**, either:
   - **Forwarded** (the number stays with the company's phone company): buy
     a Twilio number for this company alone. The company is recognised by
     that Twilio number, because the forwarding carrier does not reliably
     pass on the original number.
   - **Ported**: port the company's number into the FourPoints Twilio
     account. The call arrives on the company's own number.
2. **Webhook** — on the Twilio number, **A call comes in**
   `https://phone.example.com/voice/org/incoming` (POST).
3. **Add the company** to `apps/telephony/src/companies.ts`:

   ```ts
   {
     orgNumber: 123,                      // as in the FourPoints admin console
     organizationId: '3f1c…',             // must belong to orgNumber
     companyName: 'Acme Health',          // spoken in the welcome
     lines: [{ twilioNumber: '+15557654321' }],
     humanNumber: '+18885550000',         // optional: their OPI line
     welcome: 'Thank you for calling Acme Health.', // optional
   }
   ```

   `twilioNumber` is the number the call arrives on in Twilio, and the only
   one matched. When callers dial it directly (a number we gave the company,
   or theirs ported in), that's all you list. Only for a **forwarded**
   number, add `publicNumber`: the company's own number that forwards to
   `twilioNumber`, kept as a record. All numbers in `+1…` (E.164) form. The
   gateway refuses to start on a duplicate Twilio number or `orgNumber`, or
   a badly formed number; a wrong `organizationId` is refused by FourPoints
   on every call.

4. **Forwarding** — if forwarded, the company turns on forwarding from its
   number to the Twilio number.
5. **Access code** — whether callers enter a code depends only on whether
   the organization has an organization-wide code in FourPoints (active or
   paused → code asked; none → straight in). Create or skip it to match
   what the company chose.
6. **Welcome recording** — record "Welcome to Acme Health."
   (exactly the entry's `welcome`, or `Welcome to <companyName>.` without
   one), then:

   ```bash
   node ivr-audio/pipeline.mjs import welcome-org-123 ~/Desktop/acme.m4a "Welcome to Acme Health."
   open ivr-audio/review/index.html                # listen
   node ivr-audio/pipeline.mjs approve welcome-org-123
   ```

   Rebuild and deploy the gateway image (prompts ship in it). Until then
   the sentence is read aloud with `<Say>`.

## Hosting requirements

- Public **HTTPS and WSS on 443 with a CA-signed certificate** for `/voice/*`
  and `/media`; the proxy must pass WebSocket upgrades. Twilio has no fixed IP
  ranges, so allow 443 from anywhere — signatures are the access control.
- `PUBLIC_BASE_URL` must be exactly the origin Twilio uses (TLS may terminate
  upstream; signatures are checked against this value).
- Proxy/load-balancer connection lifetime ≥ 4 h (Twilio's call limit).
- Outbound access to FourPoints and, for machine auth, the token endpoint.
- Outbound access to `api.twilio.com` (human → AI `###`: the gateway
  redirects the interpreter's leg through the Twilio REST API).
- Container: `apps/telephony/Dockerfile` (non-root, `NODE_ENV=production`,
  `/healthz`). On SIGTERM it stops taking calls and drains for 25 s.

## Scaling

- **No shared state.** Webhooks are stateless (choices travel in signed URLs,
  with the menu version so another instance never misreads a keypress); a
  call's state lives only on its own socket. Add instances behind any load
  balancer — no stickiness, no Redis.
- **Capacity** = instances × `MAX_CALLS`. Keep that at or below what the
  FourPoints telephony tasks accept (per task: 50 sessions, 20 concurrent
  turns). Beyond capacity, new AI calls are refused and go to a human.
- **Fixed CPU per call**: μ-law is table lookup; resampling is a 24-tap
  polyphase filter; one token request is shared by all calls on an instance.
- **Bounded memory**: webhook bodies ≤ 16 KB, Twilio messages ≤ 64 KB, a
  stalled FourPoints link is dropped at 256 KB buffered instead of queuing.
- **Long calls**: FourPoints ends sessions at 30 min / 200 turns; the gateway
  rotates to a fresh session between turns before either limit.

## Configuration

See `.env.example` — every variable is documented there. The gateway refuses
to start in `NODE_ENV=production` without https, wss, machine auth and
signature validation.

For the human-call relay: `TWILIO_ACCOUNT_CLIENT_SID` and
`TWILIO_ACCOUNT_CLIENT_SECRET` (Console → Account → API keys & tokens →
create a Standard key), stored where the Auth Token is stored, and
`HUMAN_RELAY` (`company`, the default, or `off`). Without the key, or with
`HUMAN_RELAY=off`, human calls use `<Dial>` and `###` can't leave them;
AI → human needs neither.

## Known limits and things to confirm on the first real calls

- No barge-in (by design, see Echo).
- `INPUT_SAMPLE_RATE_HZ=8000` (native phone audio) is untested in FourPoints;
  the default 16000 matches the browser. A/B it per language before switching.
- VAD thresholds are FourPoints' browser defaults; tune `VAD_MIN_RMS` on real
  phone audio.
- Twilio's documentation is inconsistent on whether a server-closed media
  stream continues at `<Connect action>`. Stop FourPoints during a test call
  and confirm the caller reaches a human. The same continuation carries
  `###` from AI to human.
- **Human → AI by listening to a copy of the audio did not work** (live
  test 2026-10-23: the copy arrived but carried no key tones), so human
  calls on a company line are relayed instead. Still to confirm on real
  calls: the relay's added delay, that an OPI menu accepts the keys played
  as tones, and the cost (about $0.031/min against $0.0225/min for
  `<Dial>`, from Twilio's US prices of August 2026).
- The reason a relay ended is kept in the gateway's memory for
  `/voice/relay-ended`. Helicarrier runs one instance; with several, a call
  could land on another and be treated as unanswered.
- An OPI menu that itself asks for `###` within 5 seconds would switch the
  caller to AI.

## Tests

`npm test` covers the μ-law codec and filters (including frequency response),
Twilio's published signature example, the IVR TwiML, the floor state machine,
configuration guards, and an in-process end-to-end call: fake Twilio → real
gateway → fake FourPoints speaking protocol v1.

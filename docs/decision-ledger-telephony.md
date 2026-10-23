# Telephony decisions (draft for the FourPoints Decision Ledger)

Status `PROPOSED` until the FourPoints team accepts them; append to
`docs/architecture/decision-ledger.md` during migration.

```text
Decision ID: TELEPHONY-001
Decision: Telephony is a separate service (@fourpoints/telephony) that speaks
  realtime protocol v1 as an ordinary client. No change to apps/realtime,
  apps/web or any package.
Reason: Twilio is only an audio carrier; FourPoints already owns recognition,
  translation, quality gating and speech. A client keeps the realtime service
  untouched, scales independently, and lets the gateway be built and tested
  before write access to FourPoints exists.
Evidence: In-process end-to-end test drives a fake FourPoints that follows the
  apps/realtime message order (session.start → languages.available →
  conversation.start → turn.start / binary 0x01 frames / turn.end →
  tts.started / 0x02 frames / tts.ended → metrics.turn).
Tradeoff: One more service to deploy and operate.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-002
Decision: Turn-taking runs in the gateway: the FourPoints browser EnergyVad
  (copied unchanged) plus a half-duplex floor state machine mirroring
  auto-conversation.ts. Caller audio is discarded while cues or translations
  play and for a 300 ms guard; cue tones replace the browser's visual states;
  DTMF * switches the next speaker. Barge-in is not supported.
Reason: The realtime server has no endpointing and only speaks after
  turn.end. Twilio offers no echo cancellation for PSTN calls or Media
  Streams, so SLICE9-003's half-duplex policy is the echo control here too.
Evidence: Floor unit tests (alternation, quality FAIL keeps the speaker,
  audio discarded while processing/playing, * swap, watchdog, stop).
Tradeoff: No interruption of translated speech; VAD thresholds are browser
  defaults pending real phone-audio tuning.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-003
Decision: Caller audio (8 kHz μ-law) is decoded and upsampled to 16 kHz PCM16
  and declared as 16000 Hz in turn.start — the browser's tested contract.
  INPUT_SAMPLE_RATE_HZ=8000 (native narrowband) is available but off.
  FourPoints' 16 kHz speech is decimated to 8 kHz and μ-law encoded for Twilio.
Reason: FourPoints has never run an 8 kHz turn end to end, although it passes
  the rate through to Transcribe (which documents 8 kHz for telephone audio).
  Out of the box, the gateway uses only the validated path.
Evidence: Filter tests: unity gain at 1 kHz, ≥40 dB rejection of aliases and
  images, bit-identical output across arbitrary chunk boundaries.
Tradeoff: Upsampling adds no information; 8 kHz may transcribe as well or
  better. Requires a per-language A/B before switching.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-004
Decision: Deployed access for the gateway is infrastructure only: a Cognito
  client-credentials app client, a second realtime ECS service from the same
  image with REQUIRE_AUTH unset, and an ALB rule on /ws/telephony with
  jwt-validation (signature, iss, exp, scope, client_id) forwarding to it.
Reason: /ws admits only browser Cognito sessions; a server cannot log in. ALB
  JWT verification validates machine tokens without application changes.
  Rejected: scripting a browser login for a service user (brittle, a human
  identity as a service identity); sending a hand-made x-amzn-oidc-data header
  (relies on the unverified-signature deferral A-015 and bypasses auth).
Evidence: AWS ELB "Verify JWTs using an Application Load Balancer"
  (HTTPS listener, RS256, public JWKS ≤10 keys / ≤150 KB).
Tradeoff: SECURITY EXCEPTION — the telephony realtime service has no
  application-level upgrade check; compensating controls are ALB JWT
  validation and a security group admitting only the ALB. Removable later by
  verifying the bearer token inside apps/realtime.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-005
Decision: No Twilio SDK. TwiML is rendered by a small escaping XML builder and
  X-Twilio-Signature is validated with node:crypto (HMAC-SHA1, timing-safe
  compare). Runtime dependencies: ws only.
Reason: Smaller supply chain and image for a security-sensitive edge service;
  both pieces are a few dozen lines.
Evidence: Unit test reproduces Twilio's published worked example
  (L/OH5YylLD5NRKLltdqwSvS0BnU=); tamper, URL, token and ordering cases;
  unsigned webhooks return 403 and unsigned media upgrades are refused.
Tradeoff: If Twilio changed its signing scheme, this code must follow; the
  pinned vector would fail first.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-006
Decision: Horizontal scaling without shared state. IVR webhooks are pure
  functions of the signed request; the language-menu version travels in
  action URLs; per-call state exists only on the call's socket. Capacity is
  instances × MAX_CALLS; overflow and FourPoints failures fall back to a
  human interpreter via <Connect action>.
Reason: Unlike per-process consumption counters (A-011), nothing here becomes
  wrong when more instances are added.
Evidence: Stale-menu-version test re-reads the menu instead of misrouting a
  keypress; capacity refusal returns 503 on the media upgrade.
Tradeoff: Capacity limits are per instance, not fleet-wide — deliberate, and
  safe because overflow degrades to a human rather than failing the call.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-007
Decision: The human path is <Dial><Number> (up to 10 numbers, simultaneous
  ring, per-language lists with a default) with a whisper that requires the
  interpreter to press 1.
Reason: Quickest reliable human hand-off; the keypress stops voicemail from
  answering a caller.
Evidence: IVR tests for per-language numbers, whisper, accept/decline, and the
  "try the AI instead" offer after an unanswered dial.
Tradeoff: No queueing or interpreter presence; TaskRouter or the Voice SDK can
  replace it later without touching the AI path.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-008
Decision: The floor's speaker is an EXPECTATION. Each turn.start asks
  FourPoints to identify which conversation language is spoken
  (detectLanguage, FourPoints LANGID-001); on `turn.speaker` the floor takes
  the confirmed speaker, so the next tone goes to the other party of who
  actually spoke. Supersedes the strict alternation in TELEPHONY-002.
  DETECT_SPEAKER_LANGUAGE=false restores strict alternation.
Reason: Owner, 2026-10-05: a party who keeps speaking their language must
  keep it; with strict alternation a patient's second consecutive turn was
  recognised as English and translated the wrong way.
Evidence: floor tests (follows a confirmed speaker; ignores one outside a
  turn); integration test asserts detectLanguage on turn.start; FourPoints
  staging measurement in LANGID-001.
Tradeoff: ~0.5 s more per turn before translation; sub-second answers are
  replayed in the expected language (FourPoints side) and so behave as
  before. Star still switches the expected speaker by hand.
Status: ACCEPTED (owner)
```

```text
Decision ID: TELEPHONY-009
Decision: IVR prompts are pre-recorded (ElevenLabs eleven_v4, voice Lauren B,
  8 kHz μ-law WAV, ivr-audio/) and played with <Play> from
  /prompts/<id>.wav?v=<content hash>, instead of Twilio <Say>. A clip is
  used only when its text equals the line the code would say; otherwise
  that line is a <Say>. The AI greeting (English, then the caller's
  language) is played by the gateway into the media stream while the
  FourPoints session opens, with hold music if it is still opening. Up to
  ten menu languages are one key each (tenth = 0).
Reason: Owner, 2026-10-13: callers complained of long, odd silences after
  each choice and before the AI interpreter; <Say> is synthesized per call,
  and the session was opened only after the greeting finished. A two-digit
  menu also made every caller wait 3 s for a possible second digit.
Evidence: prompts tests (clip/text matching, every IVR line covered by an
  approved clip); integration tests (greeting → hold music → clear → first
  tone; no music when FourPoints is ready; /prompts route); ivr tests for
  one-key and two-digit menus. Each clip's transcript was checked against
  its text with ElevenLabs speech-to-text before approval.
Tradeoff: Changing a line or the menu order needs a regenerated clip (until
  then that line falls back to <Say> in another voice). Non-English greeting
  text was drafted, not professionally translated: native review needed
  before patient calls. The prompt WAVs ship in the gateway image: the
  .dockerignore "no audio in images" rule keeps excluding everything except
  ivr-audio/final (synthetic, approved prompts; no caller audio).
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-010
Decision: A company may have phone numbers of its own (dedicated lines). A
  call is matched to the company by the Twilio number it arrives on (Twilio
  `To`, covered by the Twilio signature), listed by hand in
  apps/telephony/src/companies.ts (orgNumber, organizationId, companyName,
  lines [{twilioNumber, publicNumber?}], optional humanNumber; publicNumber
  only for a forwarded number, as a record, never matched). A company's
  number reaches us either FORWARDED (it stays with the company's carrier
  and forwards to a Twilio number FourPoints buys for that company alone) or
  PORTED into FourPoints' Twilio account (the call arrives on the company's
  own number). Numbers not in the list are the shared FourPoints line,
  unchanged. Twilio's `ForwardedFrom` is not used.
Reason: Owner, 2026-10-23: companies give their customers their own number
  and want their own greeting on it. On a forwarded call Twilio sees our
  number as `To`, and passes the company's number in `ForwardedFrom` only
  when the forwarding carrier sends it, which Twilio says not all do; a
  Twilio number per company is always present and cannot be set by the
  caller. Caller ID is still not proof of who the organization is.
Evidence: Planned tests: listed number → company flow; unlisted number →
  shared line; the gateway refuses to start on a duplicate Twilio number,
  a duplicate orgNumber or a number not in E.164 (+1…) form; an
  organizationId that does not belong to orgNumber is refused by FourPoints.
Tradeoff: One Twilio number (about $1–2 a month) per forwarded company. The
  list lives in code until a FourPoints table (with admin upload behind the
  existing Cognito-via-ALB login) replaces it; the IVR reads it through a
  CompanySource interface so that swap does not change the IVR. Needs the
  FourPoints source-of-truth §6 change (dedicated numbers) to be accepted.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-011
Decision: A call on a company number opens with that company's welcome,
  "Welcome to <companyName>.", instead of the FourPoints
  welcome. The clip id is always welcome-org-<orgNumber>. The owner records
  it and imports it with `node ivr-audio/pipeline.mjs import <id> <file>
  "<text>"` (same processing as generated speech: trimmed, −19 LUFS, 8 kHz
  mono μ-law; reviewed and approved like any clip). Until a clip with that
  exact text is approved, the sentence is spoken with <Say>.
Reason: Owner, 2026-10-23. Clip names need not be hidden. The same
  "text must match" rule as TELEPHONY-009 keeps a stale or mistyped
  recording from playing the wrong company's name.
Evidence: pipeline import tested end to end on a throwaway recording
  (review files, review page, approve → manifest entry of kind
  "recording", loaded by the gateway's PromptLibrary). Planned IVR test:
  missing recording → <Say> of the same sentence.
Tradeoff: The recording ships in the gateway image with the other prompts;
  each new company needs a rebuild until recordings move to S3.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-012
Decision: On a company number the caller is never asked for an organization
  ID. The gateway asks FourPoints (POST /internal/phone/line, same machine
  scope and time limit as /internal/phone/resolve) about the company:
  - organization-wide access code exists, ACTIVE or PAUSED → the caller must
    enter a valid access code (the organization's or a person's), checked
    with the existing /internal/phone/resolve; a wrong code is retried as
    today ("Sorry, that access code was not recognized.");
  - no organization-wide code → the call goes straight in, counted under the
    company, not a person.
  FourPoints checks organization status, phone access, AI/human entitlement
  and minutes left on every call and fails closed.
Reason: Owner, 2026-10-23 (source-of-truth change): with no code, the number
  itself identifies the company. A paused code still counts as a code, so
  pausing never opens a line.
Evidence: Planned tests: with code / paused code / no code; person's code;
  wrong code retries; not ACTIVE, no phone access, out of minutes →
  existing goodbyes; FourPoints timeout or error → existing check-failed
  line.
Tradeoff: With no code, anyone who knows the number uses the company's
  minutes; the company accepts this by choosing no code. Removing a
  company's code opens its line (the admin console should warn later). The
  onboarding answer access_code_entry does not drive the line; whether a
  code exists does.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-013
Decision: A company may set its own human interpreter line (OPI number,
  humanNumber). Human calls for that company dial it directly: no language
  menu (the OPI side sorts out the language) and no "Press 1 to accept"
  whisper screening. Time on the OPI number counts against the company's
  monthly minutes, the same as FourPoints human calls. Companies without
  humanNumber use the FourPoints interpreters as today.
Reason: Owner, 2026-10-23. An OPI line answers with its own menu or queue
  and nobody there would press 1, so screening would hang up every call;
  the caller goes through the OPI menu as if they had dialled it.
Evidence: Planned tests: company with humanNumber → <Dial> of that number,
  no language menu, no whisper URL; company without → existing interpreters.
Tradeoff: Without screening, an OPI voicemail or closed-hours message would
  pick up and the minutes still count. Live test: a real OPI line works
  when connected straight through.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-014
Decision: Pressing # three times (within 5 s, no other key between) during an
  AI call moves the caller to a human interpreter, where the organization has
  human. The gateway drops any half-recorded turn (the key tones are never
  translated) and closes the media stream; Twilio continues at
  /voice/ai-ended, the AI usage leg ends and the human leg starts:
  "Connecting you to a human interpreter. Please hold." → the company's OPI
  number, or "… for <Language>. Please hold." → the FourPoints interpreters
  for the call's language. The stream carries only a yes/no transfer flag
  (no organization data); without it, ### is ignored. Changed behaviour:
  /voice/ai-ended no longer says "The AI interpreter is unavailable." itself,
  because it cannot tell a caller's ### from an AI failure; on a failure the
  gateway plays that line into the stream before closing it.
Reason: Owner, 2026-10-23. One or two # and * keep working as before.
Evidence: Planned tests: ### closes the stream; #, ##, too slow, #*# do
  nothing; no transfer flag → ignored; a half-recorded turn is not sent; the
  right human number is dialled; AI failure still plays the unavailable line.
Tradeoff: Callers are not told about ### (would mean re-recording the ten
  ai-connected-* clips; open question). Live test: Twilio continues at
  <Connect action> after a server-closed stream (already listed under
  "Known limits").
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-015
Decision: Pressing # three times during a human call moves the caller to the
  AI interpreter, where the organization has AI. Before the human is
  dialled, the TwiML starts a one-way copy of the CALLER's side of the
  audio only to the gateway (/watch, same Twilio signature check as /media).
  The gateway only detects # tones (941 Hz + 1477 Hz) in memory; the audio
  is never stored, never transcribed and never sent to FourPoints. The
  interpreter's side is not in the copy, so the interpreter pressing # does
  nothing. On ###, the gateway uses the Twilio REST API to redirect the
  interpreter's leg: it hears "The caller has switched to the AI
  interpreter. Goodbye." and is hung up. Twilio then calls
  /voice/human-result with the call's state and without DialCallDuration
  (it is absent when the other leg was redirected), which is how the switch
  is told apart from the interpreter hanging up. The human usage leg ends;
  the caller hears "Switching you to the AI interpreter." and then the
  language menu (no welcome, no AI/human menu), because the OPI side cannot
  tell us which language was used.
Reason: Owner, 2026-10-23 (caller-audio copy approved). In a human call
  Twilio <Dial> joins the two parties directly and does not report
  keypresses, so the gateway must hear the tones itself.
Evidence: Planned tests: tone detector on generated # tones, other keys,
  speech and noise; human-result with and without DialCallDuration; switch
  line then language menu; REST call time limit and failure. Needs
  TWILIO_ACCOUNT_CLIENT_SID / TWILIO_ACCOUNT_CLIENT_SECRET on the gateway (stored like the
  Auth Token) and outbound access to api.twilio.com.
Tradeoff: If an OPI menu ever asks for ### within 5 s it would switch to AI
  (an account number then # does not). UNVERIFIED until the live test on an
  upgraded Twilio number: (1) the # tones are present in the copied audio
  (some networks send keys out of band and Twilio may strip them; if not,
  back to the owner — * was offered, not approved); (2) redirecting the
  interpreter leg ends the <Dial> with completed and no DialCallDuration;
  (3) a real OPI line works with no screening. Part 3 is not built before
  that test.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-016
Decision: The switch key is ### in both directions, and a call may switch at
  most 3 times; after that ### is ignored. What the organization has is
  respected: AI-only means no ### to human, human-only means no caller-audio
  copy. Presentation mode does not change. 000 was considered and rejected.
Reason: In a human call the caller is typing into the company's OPI menu,
  where account numbers, PINs and "press 0 for an operator" would set off
  000 by accident. The cap stops endless back-and-forth and limits how
  often the minute cap is reset, since each human leg's time limit is
  computed from the minutes left at the start of the call.
Evidence: Planned tests: fourth ### ignored; AI-only and human-only
  organizations.
Tradeoff: A caller who needs a fourth switch has to call again.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-017
Decision: Human calls to a company's own interpreter line are relayed through
  the gateway instead of joined by Twilio <Dial>. The caller's call opens a
  two-way stream (/relay); the gateway rings the interpreter line with the
  Twilio REST API (caller ID: the company number the caller dialed), whose
  TwiML opens a second two-way stream (/relay-leg); the gateway passes the
  8 kHz mu-law frames between them unchanged, in memory only. The caller's
  keys arrive as Twilio dtmf events: ### moves the caller to the AI (the
  interpreter's leg gets the interpreter-released notice and hangs up; the
  caller continues at <Connect action> /voice/relay-ended to the language
  menu); every other key is played to the interpreter line as a DTMF tone so
  its own menu keeps working. Hold music plays while the line rings (35 s).
  The reason a relay ended is kept in the gateway's memory for
  /voice/relay-ended (one Helicarrier instance). HUMAN_RELAY=off returns to
  <Dial>. Calls to FourPoints' own interpreters still use <Dial>. The /watch
  audio copy (TELEPHONY-015) is removed. After the AI greeting, callers on
  calls where ### can reach a human hear "To switch to a human interpreter,
  press pound three times." (English only).
Reason: Live test 2026-10-23: the one-way copy of the caller's audio during
  <Dial> arrived (511 frames on the inbound track) but carried no key tones
  and no key events, so ### could not be heard. Twilio's only key feature
  during <Dial> is hangupOnStar, a single *, which the owner rejected in
  favour of ### both ways.
Evidence: relay.test.ts (ringing, audio both ways, ###, keys as tones,
  interpreter hang-up, busy/no answer, ring timeout, caller hang-up, refused
  streams, content-free logs); ivr-company.test.ts (relay TwiML carries only
  lang, limit and a yes/no; /voice/relay-ended outcomes).
Tradeoff: Every company human call now depends on the gateway and adds two
  network hops. Cost per minute (Twilio US prices, August 2026): <Dial>
  $0.0085 in + $0.0140 out = $0.0225; relay adds two Media Streams at
  $0.0044 = $0.0313 (about +$0.0088/min, +39%). The owner will judge
  latency and cost on real calls and can switch it off with HUMAN_RELAY.
  The deviation from SoT section 6 (Twilio Conference for the human path)
  already existed with <Dial>.
Status: PROPOSED
```

```text
Decision ID: TELEPHONY-018
Decision: In the human-call relay (TELEPHONY-017), the caller's keys (other
  than ###) are sent to the interpreter line as real digits: the gateway
  waits for a 1 s pause, gives the interpreter's leg TwiML
  <Play digits="w..."/> followed by a fresh <Connect><Stream> into the same
  relay, and re-attaches the new stream (15 s limit, else the relay ends as
  interpreter_ended). A completed ### is never sent. Keys pressed while the
  line is still ringing are ignored.
Reason: Live test 2026-10-23: VerbatUm's interpreter line asks callers to
  press keys, and the DTMF tones the gateway played into the audio were not
  accepted. Twilio media streams cannot send key events (only media, mark
  and clear), and <Play digits> is Twilio's way to send real digits.
Evidence: relay.test.ts (keys batched into one <Play digits>, old stream's
  stop is not a hang-up, audio flows on the re-joined stream, re-join
  timeout, ### never sent).
Tradeoff: Each batch of keys costs one Twilio REST request and a short gap
  (about a second) in the audio while the leg re-joins; acceptable while
  the caller is in the line's menu, not mid-conversation.
Status: PROPOSED
```

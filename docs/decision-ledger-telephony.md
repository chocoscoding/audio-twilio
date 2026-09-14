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

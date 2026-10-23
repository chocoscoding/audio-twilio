# Deploying the FourPoints phone gateway

The gateway (`apps/telephony`) answers a Twilio phone number, plays the
menu, and bridges the call audio to the FourPoints realtime backend over a
WebSocket. It is one stateless Node container; FourPoints does all the
speech recognition, translation and speech output.

```
Caller ── Twilio ──HTTPS/WSS──▶ gateway (:8080) ──WSS──▶ FourPoints realtime (/ws/telephony)
                  /voice/*, /media, /watch                conversation.start {clinician, patient}
```

## Where it runs: Helicarrier

| What           | Value                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Project        | `fourpoints` (Helicarrier), environment `production`                                                  |
| Service        | `telephony`, one replica, plan `heli-s2`                                                              |
| Public address | `https://telephony.on.helicarrier.xyz`                                                                |
| Built from     | GitHub `chocoscoding/audio-twilio`, branch `master`, `apps/telephony/Dockerfile`                      |
| Talks to       | staging FourPoints: `wss://staging.fourpointsls.com/ws/telephony` (machine login) and the staging API |

**A push to `master` is a deploy.** Helicarrier builds and replaces the
running gateway on every push (about a minute), so every caller on the phone
line gets the new code at once. Commit freely, but push only what should go
live, after `npm run build && npm test && npm run lint` pass.

**Settings live in Helicarrier, not in the repo.** Service → environment
variables. A setting changed there takes effect on the next deploy or
restart. The keys set today (values hidden):

| Group      | Keys                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Twilio     | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_CLIENT_SID`, `TWILIO_ACCOUNT_CLIENT_SECRET`                                                       |
| FourPoints | `FOURPOINTS_WS_URL`, `FOURPOINTS_AUTH`, `FOURPOINTS_TOKEN_URL`, `FOURPOINTS_CLIENT_ID`, `FOURPOINTS_CLIENT_SECRET`, `FOURPOINTS_SCOPE`, `FOURPOINTS_API_URL` |
| Call line  | `PUBLIC_BASE_URL`, `CLINICIAN_LANGUAGE_ID`, `HUMAN_INTERPRETER_NUMBERS`, `INPUT_SAMPLE_RATE_HZ`, `MAX_CALLS`, `PRESENTATION_MODE`, `PROMPT_VOICE`            |

Every variable is described in `apps/telephony/.env.example`. The gateway
checks them at start-up and refuses to start with a list of problems, so a
bad value shows up as a failed deploy, not a broken call. In particular
`TWILIO_ACCOUNT_CLIENT_SID` must be `SK` + 32 hex characters and set together
with `_SECRET` (needed for `###` from a human call to the AI).

Company numbers (`apps/telephony/src/companies.ts`) and recorded prompts
(`ivr-audio/final`) ship inside the image, so adding a company or a prompt
is a commit and a push, not a setting.

### Check a deploy

1. Helicarrier → `telephony` → **Deployments**: the newest one, with your
   commit, is `active`.
2. **Logs**: one `telephony.listening` line from the new start, showing the
   FourPoints URL, `organizationLine: true`, `humanToAi: true`,
   `companyNumbers` and `recordedPrompts`.
3. From a terminal:

   ```bash
   curl -s https://telephony.on.helicarrier.xyz/healthz
   ```

   answers `{"status":"ok",…}`; a new prompt answers 200 at
   `/prompts/<id>.wav`; an unsigned `POST /voice/incoming` answers 403.

4. Make a test call (synthetic content only).

### Roll back

Helicarrier → `telephony` → **Deployments** → the previous deployment →
**Roll back**. Or revert the commit and push. Rolling back the gateway never
needs a FourPoints change.

### Twilio numbers

Each number's **A call comes in** webhook points at the gateway's public
address (`PUBLIC_BASE_URL`): `/voice/incoming` for the current FourPoints
number, `/voice/org/incoming` for the organization line and every company
number. Trial Twilio accounts can't stream or dial out; the account must be
upgraded. Call recording stays off.

## Run it locally (local backend, public tunnel)

Everything runs on one machine; only the gateway is exposed, through a
cloudflared quick tunnel. Use synthetic conversations only — no real patient
calls until there is a Twilio BAA.

1. **Backend** — in `FourPoints/`, with `REQUIRE_AUTH=false` in `.env`:

   ```bash
   npm run build
   node --env-file=.env apps/realtime/dist/index.js
   ```

   It needs AWS credentials for Transcribe, Translate, Polly and Bedrock in
   `us-east-1` (e.g. `AWS_PROFILE=… AWS_REGION=us-east-1`).

2. **Gateway settings** — `apps/telephony/.env`:

   ```
   TWILIO_ACCOUNT_SID=…
   TWILIO_AUTH_TOKEN=…
   TWILIO_PHONE_NUMBER=+1…
   PRESENTATION_MODE=false
   FOURPOINTS_WS_URL=ws://localhost:8787
   FOURPOINTS_AUTH=none
   CLINICIAN_LANGUAGE_ID=en-US
   HUMAN_INTERPRETER_NUMBER=+1…
   ```

3. **Start** — in `audio-twilio/`:

   ```bash
   npm run build
   npm run present
   ```

   This opens a cloudflared tunnel, points your Twilio number's
   **A call comes in** webhook at `<tunnel>/voice/incoming`, and starts the
   gateway. The tunnel URL changes every run; the script re-points the number
   each time. It does not restore the old webhook when you stop it.

4. **Call the number**, press 1, choose a language. `logs/gateway.jsonl` should
   show `call.started` then `fourpoints.session_opened` with your language.

## Another container host (not used today)

### 1. Build the image

From the repo root:

```bash
docker buildx build --platform linux/arm64 --provenance=false --sbom=false \
  --build-arg APP_VERSION="sha-$(git rev-parse --short HEAD)" \
  -f apps/telephony/Dockerfile -t "$REPO:sha-$(git rev-parse --short HEAD)" .
docker push "$REPO:sha-$(git rev-parse --short HEAD)"
```

The image runs as a non-root user with `NODE_ENV=production` and listens on
**8080**. Before shipping it next to FourPoints, pin the base image by digest
the way `FourPoints/apps/realtime/Dockerfile` does.

### 2. Host it

Any container host works (ECS Fargate next to FourPoints is the natural
choice). Requirements:

- Public **HTTPS/WSS on 443** with a CA-signed certificate, passing WebSocket
  upgrades for `/voice/*` and `/media`. Allow 443 from anywhere — Twilio has no
  fixed IPs; request signatures are the access control.
- Load balancer idle/connection timeout long enough for a whole call (Twilio
  allows up to 4 h).
- Health check: `GET /healthz` → 200 (503 while draining).
- Stop timeout ≥ 30 s: on SIGTERM the gateway stops taking calls and drains
  for 25 s.
- Outbound access to the FourPoints WebSocket and the Cognito token endpoint.
- Scale by adding instances — no shared state, no sticky sessions. Capacity is
  instances × `MAX_CALLS`; calls over capacity go to a human interpreter.

### 3. Configure it

Store secrets in your secret manager, not in the image.

| Variable                                  | Required | Production value / rule                                             |
| ----------------------------------------- | -------- | ------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`                         | yes      | `https://phone.<domain>` — exactly the origin Twilio calls; no path |
| `TWILIO_ACCOUNT_SID`                      | yes      | `AC…`                                                               |
| `TWILIO_AUTH_TOKEN`                       | yes      | secret; used to verify every webhook and media stream               |
| `FOURPOINTS_WS_URL`                       | yes      | `wss://…` (plain `ws://` is refused in production)                  |
| `FOURPOINTS_AUTH`                         | yes      | `client-credentials` (`none` is refused in production)              |
| `FOURPOINTS_TOKEN_URL`                    | yes      | Cognito token endpoint                                              |
| `FOURPOINTS_CLIENT_ID` / `_CLIENT_SECRET` | yes      | secret                                                              |
| `FOURPOINTS_SCOPE`                        | yes      | the telephony scope FourPoints defines                              |
| `HUMAN_INTERPRETER_NUMBER(S)`             | yes      | fallback interpreters, E.164                                        |
| `CLINICIAN_LANGUAGE_ID`                   | —        | `en-US`                                                             |
| `MAX_CALLS`                               | —        | `20` per instance                                                   |
| `VAD_HANGOVER_MS`                         | —        | `1150` — silence that ends a caller's turn                          |
| `INPUT_SAMPLE_RATE_HZ`                    | —        | leave at `16000`; FourPoints rejects anything else                  |
| `DETECT_SPEAKER_LANGUAGE`                 | —        | default `true`: FourPoints checks who actually spoke (LANGID-001)   |
| `PRESENTATION_MODE`                       | —        | `false`                                                             |
| `FOURPOINTS_API_URL`                      | —        | organization line only: FourPoints API origin, `https://…`          |
| `FOURPOINTS_PHONE_SCOPE`                  | —        | `fourpoints-internal/phone.resolve` (default)                       |

`TWILIO_VALIDATE_SIGNATURES=false` is refused in production. The gateway
checks all of this at start-up and exits with a list of every problem.

### 4. Point Twilio at it

Twilio Console → Phone Numbers → your number → Voice Configuration:

- **A call comes in:** Webhook, `https://phone.<domain>/voice/incoming`, POST
- **Call status changes** (optional): `https://phone.<domain>/voice/status`

The **organization line** (a second number: caller enters the organization
ID, then an access code) uses `https://phone.<domain>/voice/org/incoming`
instead, and needs `FOURPOINTS_API_URL`. Do not change the current number.

The account must be upgraded (trial accounts block `<Stream>` and `<Dial>`),
and call recording stays off.

### 5. Check it

- `curl https://phone.<domain>/healthz` returns `{"status":"ok",…}`.
- Call the number, press 1, pick a language: you hear
  "You are connected to the FourPoints <language> AI Interpreter…", and a
  spoken sentence comes back translated.
- Gateway logs show `call.started` and `fourpoints.session_opened`; no
  `webhook.rejected` lines (that means `PUBLIC_BASE_URL` or the auth token is
  wrong).

### Rolling back

Redeploy the previous image tag. If the gateway is down, calls fail at
Twilio — to keep the line answering, set the number's fallback URL to a
TwiML Bin that dials a human interpreter.

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
   languages FourPoints can hear and speak; up to 14; two-digit entries end
   with `#`). Invalid input re-prompts three times, then reaches a human.
2. **AI path** — Twilio opens a media stream to the gateway, which opens one
   FourPoints session (`session.start` → `conversation.start`, clinician
   language = `CLINICIAN_LANGUAGE_ID`).
3. **Taking turns** — a phone has no screen, so tones hand over the floor:
   **low tone** = clinician speaks, **high tone** = patient speaks, **double
   beep** = "not translated, please repeat". **Star** switches who speaks next.
   The gateway detects speech (`vad.ts`, the FourPoints browser VAD), streams
   the turn to FourPoints, and plays the translation back.
4. **Human path, and every failure** — `<Dial>` rings the configured
   interpreters at once; each hears "FourPoints interpretation call for
   Spanish. Press 1 to accept" so voicemail cannot answer. If the AI stream
   fails (FourPoints down, gateway full), Twilio continues at
   `<Connect action>` and the caller is put through to a human.

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
3. **Host the gateway** (next section) at e.g. `https://phone.example.com`.
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
8. **Deployed FourPoints** — the live stack only admits browser logins; send
   `docs/fourpoints-exposure.md` to the FourPoints team (infrastructure only),
   then switch `FOURPOINTS_WS_URL` / `FOURPOINTS_AUTH` as described there.

## Hosting requirements

- Public **HTTPS and WSS on 443 with a CA-signed certificate** for `/voice/*`
  and `/media`; the proxy must pass WebSocket upgrades. Twilio has no fixed IP
  ranges, so allow 443 from anywhere — signatures are the access control.
- `PUBLIC_BASE_URL` must be exactly the origin Twilio uses (TLS may terminate
  upstream; signatures are checked against this value).
- Proxy/load-balancer connection lifetime ≥ 4 h (Twilio's call limit).
- Outbound access to FourPoints and, for machine auth, the token endpoint.
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

## Known limits and things to confirm on the first real calls

- No barge-in (by design, see Echo).
- `INPUT_SAMPLE_RATE_HZ=8000` (native phone audio) is untested in FourPoints;
  the default 16000 matches the browser. A/B it per language before switching.
- VAD thresholds are FourPoints' browser defaults; tune `VAD_MIN_RMS` on real
  phone audio.
- Twilio's documentation is inconsistent on whether a server-closed media
  stream continues at `<Connect action>`. Stop FourPoints during a test call
  and confirm the caller reaches a human.

## Tests

`npm test` covers the μ-law codec and filters (including frequency response),
Twilio's published signature example, the IVR TwiML, the floor state machine,
configuration guards, and an in-process end-to-end call: fake Twilio → real
gateway → fake FourPoints speaking protocol v1.

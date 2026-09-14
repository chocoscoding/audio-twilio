# FourPoints phone line — scripted demo

Shows the telephony gateway handling a complete call — menu, media stream,
turn-taking, the quality gate and the human fallback — **without FourPoints,
AWS or a Twilio account**.

**Presenting it?** Follow [PRESENTING.md](../../PRESENTING.md): setup, the
pre-flight check, a timed run script and troubleshooting.

```
browser phone ──► Twilio emulator ──► telephony gateway ──► FourPoints stand-in
 mic + keypad      :3000, signs          :8080, unchanged       :8787, scripted
```

| Piece               | Real or stand-in                                                        | Its job in the demo                                                                                    |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Telephony gateway   | **Real** — the `apps/telephony` build, own process, signatures enforced | IVR, speech detection, turn-taking, μ-law ⇄ PCM, FourPoints protocol v1                                |
| Twilio emulator     | Stand-in for Twilio                                                     | Adds Twilio's call parameters, signs every webhook and the `/media` handshake, relays the media stream |
| Browser phone       | Stand-in for the handset                                                | Keypad and DTMF, reads `<Say>` aloud, streams the microphone as 8 kHz μ-law, plays returned audio      |
| FourPoints stand-in | Stand-in for FourPoints                                                 | Speaks protocol v1 and answers each turn with the next line of `script.json` and its recorded speech   |

## Run it

From the repository root:

```bash
npm install
npm run build
npm run demo:placeholders   # once: Windows-voice placeholders for every line
npm run demo                # leave running, then open http://localhost:3000
npm run demo:check          # in a second terminal: checks every hop
```

Open **http://localhost:3000** in Chrome or Edge and allow the microphone.

## Settings

Optional. Copy [`.env.example`](.env.example) to `apps/telephony-demo/.env`;
`npm run demo` and `npm run demo:check` read it at start-up.

| Variable                                            | Default     | Purpose                                                                   |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| `DEMO_WEB_PORT`                                     | `3000`      | Browser phone and Twilio emulator                                         |
| `DEMO_GATEWAY_PORT`                                 | `8080`      | Gateway process                                                           |
| `DEMO_FOURPOINTS_PORT`                              | `8787`      | Stand-in (same port as the real FourPoints service)                       |
| `DEMO_FOURPOINTS_HOST`                              | `127.0.0.1` | Stand-in bind address (`0.0.0.0` for a remote gateway)                    |
| `DEMO_TWILIO_ACCOUNT_SID`, `DEMO_TWILIO_AUTH_TOKEN` | random      | Fix the emulated Twilio identity                                          |
| `VAD_MIN_RMS`                                       | `0.015`     | Speech-detection threshold passed to the gateway; lower is more sensitive |

## Replace the placeholders

Record the lines listed in [RECORDING.md](RECORDING.md), save them in
`recordings/`, and restart `npm run demo`. Recordings always win over
placeholders; the console lists the source used for each line.

## Change the conversation

Edit `script.json`. Each line has a speaker, what they say, and the
translation the listener hears. Give a line
`"gate": { "status": "FAIL", "reasons": ["…"] }` to have it blocked by the
quality gate. Keep `RECORDING.md` in step with the script.

## Real phone call against the stand-in

On the machine that runs the gateway:

```bash
npm run demo:stand-in
```

Start the gateway with `FOURPOINTS_WS_URL=ws://127.0.0.1:8787` and
`FOURPOINTS_AUTH=none`, then call the Twilio number. Everything else in
`apps/telephony/README.md` (upgraded account, HTTPS hosting, webhook URL)
still applies.

## What is scripted

The stand-in does not recognise or translate speech: any utterance advances
the script, and it reports no latency figures. The demo proves the phone
integration — Twilio, the gateway and the FourPoints protocol contract — not
FourPoints' translation quality. The scenario is synthetic and contains no
patient data.

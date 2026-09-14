# Presenting the FourPoints phone line demo

Everything you need to run the demo and present it. It needs **no FourPoints,
AWS or Twilio account**: the real telephony gateway runs between a local
Twilio emulator and a scripted FourPoints stand-in, all on this laptop.

Explainer page for the team (private until you share it):
https://claude.ai/code/artifact/14976dfc-adc9-47ab-aef9-2b64d9dcd7d2

## What you need

- Windows 10 or 11 (placeholder voices use Windows' built-in speech)
- Node.js 22 or newer — check with `node -v`
- Chrome or Edge
- A microphone and speakers, or a headset
- About 10 minutes for the one-time setup

## One-time setup

In PowerShell, from the project folder:

```powershell
cd "C:\Users\ot\Desktop\WF\audio twilio"
npm install
npm run build
npm run demo:placeholders
```

Optional:

- **Settings.** The demo runs with sensible defaults. To change ports or
  microphone sensitivity, create a settings file and edit it (every setting is
  explained inside):

  ```powershell
  Copy-Item apps\telephony-demo\.env.example apps\telephony-demo\.env
  ```

- **Real voices.** Record the lines listed in
  [apps/telephony-demo/RECORDING.md](apps/telephony-demo/RECORDING.md) and save
  them in `apps\telephony-demo\recordings\`. Until then the five Spanish lines
  play an English voice saying "Placeholder for the Spanish recording…".

## 30 minutes before you present

1. Close anything using ports **3000**, **8080** or **8787** — including a
   local FourPoints realtime service.
2. Start the demo and leave this terminal open:

   ```powershell
   npm run demo
   ```

   Wait for the line `Twilio emulator + phone http://localhost:3000`.

3. In a **second** terminal, run the pre-flight check:

   ```powershell
   npm run demo:check
   ```

   Every line should start with ✓ and end with _Ready to present_. It places
   one scripted call through the same path the browser phone uses; you will
   not hear it.

4. Open **http://localhost:3000** in Chrome or Edge and allow the microphone
   when asked. Speak: the green bar under the phone screen should move. (If the
   page was already open, the check's call shows in its panels; they clear when
   you click **Call**.)
5. Set the speaker volume to about 60% and do one full run-through.
6. Open the explainer page in a second tab.

## The run (about five minutes)

1. **Set the scene.**
   - Point at the strip under the header: _Browser phone → Twilio emulator →
     Telephony gateway → FourPoints stand-in_.
   - Say: _"Everything between the phone and FourPoints is the real gateway
     build. Twilio and FourPoints are local stand-ins, so this runs without any
     accounts."_
2. **Place the call.**
   - Click **Call**. Press **1** for the AI interpreter, then **1** for Spanish.
   - Say: _"Each menu step is a webhook signed exactly the way Twilio signs it,
     and the language list comes from the FourPoints language registry."_
3. **Clinician speaks.**
   - After the **low tone**, read the line under _Clinician speaks next_.
   - Say: _"The gateway hears the end of the sentence, streams the turn to
     FourPoints over its normal protocol, and plays the Spanish back into the
     call."_
4. **Patient speaks.**
   - After the **high tone**, read the patient line. Any speech works.
   - Point at the conversation card: original, translation and _Verified ·
     spoken_.
5. **The quality gate.**
   - Continue until the dosage line, which is scripted to fail.
   - Say: _"FourPoints could not verify the dose, so nothing is spoken. The
     double beep asks the clinician to repeat."_ Read it again: it passes.
6. **Under the hood.**
   - Point at _On the wire_: Twilio webhooks and TwiML, the gateway's own log
     lines, and the FourPoints protocol messages, in order.
7. **Human interpreter.**
   - Click **Hang up**, then **Call**. Press **2**, then **1**.
   - Say: _"Human interpreters are rung at the same time, and each must press 1
     to accept, so voicemail can never take the call."_
   - Click _Simulate: no answer_. The line offers the AI instead: press **1**.
8. **Close with the next steps.**
   - FourPoints: approve the infrastructure-only exposure
     ([docs/fourpoints-exposure.md](docs/fourpoints-exposure.md)). No
     FourPoints code changes.
   - Twilio: an upgraded account and a phone number.
   - Before real patients: live FourPoints instead of the stand-in, a Twilio
     BAA, and FourPoints' approval.

## If someone asks "is it really translating?"

No. The stand-in plays pre-written lines: any speech moves the script
forward, and it reports no latency figures. The demo proves the phone
integration — Twilio, the gateway and the FourPoints protocol contract.
Translation quality is FourPoints' existing pipeline. The scenario is synthetic
and contains no patient data.

## If something goes wrong

| What you see                                                | What to do                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Could not start the FourPoints stand-in on port 8787`      | A local FourPoints is running. Stop it, or set `DEMO_FOURPOINTS_PORT=8788` in `apps\telephony-demo\.env`.    |
| `Could not start the demo page on port 3000`                | Another app uses port 3000. Set `DEMO_WEB_PORT=3100` in `.env` and open http://localhost:3100.               |
| `The gateway is not built`                                  | Run `npm run build`, then `npm run demo`.                                                                    |
| The phone screen says _Microphone needed_                   | Allow the microphone in the browser's site settings (icon left of the address), then click **Call** again.   |
| No welcome voice or tones                                   | Unmute the browser tab and the speakers, click once on the page, and check the volume.                       |
| You speak but nothing happens (no _Listening to the…_ line) | Speak closer to the microphone. In a quiet room set `VAD_MIN_RMS=0.008` in `.env` and restart the demo.      |
| The translation starts a new turn by itself                 | The speakers are loud enough to echo: lower the volume or use a headset.                                     |
| Spanish lines say "Placeholder for the Spanish recording"   | Expected until you add recordings ([RECORDING.md](apps/telephony-demo/RECORDING.md)).                        |
| The page fonts look plainer than usual                      | The laptop is offline. Everything still works.                                                               |
| `npm run demo:check` shows ✗                                | Follow the hint under the ✗ line.                                                                            |
| Anything else                                               | Press Ctrl+C in the demo terminal, run `npm run demo` again and refresh the page. It takes about 10 seconds. |

**If a port is still in use after a crash:** an earlier demo may still be
running in the background (for example, if its window was killed instead of
stopped with Ctrl+C). Close old terminal windows, or free the demo's ports —
this closes whatever is using them:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000,8080,8787 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess }
```

**If the microphone fails in the room:** run `npm run demo:check` while the
page is open. It completes a call without a microphone, and the page's
_Conversation_ and _On the wire_ panels fill in as it runs.

## Stop

Press **Ctrl+C** in the demo terminal.

## Settings

All optional, in `apps\telephony-demo\.env` — see
[apps/telephony-demo/.env.example](apps/telephony-demo/.env.example): ports,
the stand-in's address, a fixed emulated Twilio identity, and microphone
sensitivity. The conversation itself is
[apps/telephony-demo/script.json](apps/telephony-demo/script.json).

## Later: a real phone number

- Gateway settings: [apps/telephony/.env.example](apps/telephony/.env.example).
  Copy it to `apps\telephony\.env`, fill it in, and start the gateway with
  `npm run start:telephony:local`.
- Setup guide (Twilio account, number, hosting):
  [apps/telephony/README.md](apps/telephony/README.md).
- To call a real number while FourPoints is not connected, point the gateway at
  the stand-in: run `npm run demo:stand-in` on the same machine and set
  `FOURPOINTS_WS_URL=ws://127.0.0.1:8787` and `FOURPOINTS_AUTH=none`.

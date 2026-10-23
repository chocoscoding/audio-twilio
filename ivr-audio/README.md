# IVR audio

Pre-recorded prompts and hold music for the phone line, generated with
ElevenLabs. Replaces live `<Say>` synthesis (the dead air after keypresses).

| Path           | What                                                                  |
| -------------- | --------------------------------------------------------------------- |
| `script.mjs`   | Voice, language order, every line's text, music prompt                |
| `pipeline.mjs` | Generate → review → approve                                           |
| `review/`      | Stage 1, not shipped: source, phone-ready file, preview, `index.html` |
| `final/`       | Stage 2, shipped: approved clips (`<id>.wav`) + `manifest.json`       |
| `.env`         | `ELEVENLABS_API_KEY` — never commit                                   |

Final format: **WAV, 8 kHz, mono, G.711 μ-law** (Twilio's native phone
format; no transcoding on the call). Speech at −19 LUFS, music at −25 LUFS,
silence trimmed, 100 ms tail. Music is cross-faded tail-into-head so it
loops without a seam.

```bash
node pipeline.mjs audition              # sample line in each audition voice
node pipeline.mjs generate              # every missing or changed clip
node pipeline.mjs music 2               # two hold-music takes
open review/index.html                  # listen ("Phone" = exactly what ships)
node pipeline.mjs approve <ids|all>     # review → final, review copy deleted
node pipeline.mjs redo <ids>            # new take of the same text
node pipeline.mjs reject <ids>
node pipeline.mjs status
node pipeline.mjs serve                 # review page over http://localhost:4870
```

### Your own recordings (company welcomes)

Lines that are not in `script.mjs`, such as a company's welcome, are
recorded by the owner and imported. Any file ffmpeg reads works (m4a, mp3,
wav, aiff). It gets the same treatment as generated speech (silence trimmed,
−19 LUFS, 8 kHz μ-law) and appears in `review/index.html`; `approve` ships it.

```bash
node pipeline.mjs import welcome-org-123 ~/Desktop/acme.m4a "Welcome to Acme Health."
node pipeline.mjs approve welcome-org-123
```

- The id is 1–64 lowercase letters, digits or dashes, and must not be a
  `script.mjs` clip.
- The text must be exactly what the gateway expects, or it reads the line
  aloud instead (`<Say>`).
- Imported clips are never regenerated or marked stale. `status` lists them
  as recordings; `redo` refuses them (import again for a new take).

Changing a line in `script.mjs` (or the voice) marks that clip stale;
`generate` only redoes stale or missing clips.

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
```

Changing a line in `script.mjs` (or the voice) marks that clip stale;
`generate` only redoes stale or missing clips.

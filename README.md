# FourPoints telephony (staging workspace)

`@fourpoints/telephony` turns a Twilio phone number into a FourPoints
interpretation line: callers press **1** for the AI interpreter or **2** for a
human, choose a language, and talk.

This workspace mirrors the FourPoints monorepo so `apps/telephony` moves in
unchanged when write access is granted.

**Presenting the demo? Start with [PRESENTING.md](PRESENTING.md)** — setup,
a pre-flight check, the run script and troubleshooting.

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

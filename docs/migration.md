# Moving `@fourpoints/telephony` into FourPoints

This workspace mirrors the FourPoints monorepo (same root configs, a
byte-identical copy of `packages/protocol`), so the move is a folder copy plus
a few registrations. Nothing in `apps/realtime`, `apps/web` or any package
changes.

## Before moving

```bash
npm run check:protocol-sync
npm run build && npm test && npm run lint && npm run format:check
```

## Steps

1. Copy `apps/telephony/` to `FourPoints/apps/telephony/`. Do **not** copy
   `packages/protocol` — FourPoints owns it, and `check:protocol-sync` proved
   the copy here is identical.
2. `FourPoints/tsconfig.json`: add `{ "path": "apps/telephony" }` to
   `references`.
3. `FourPoints/package.json` scripts: add
   `"start:telephony": "node apps/telephony/dist/index.js"` and
   `"call:fake": "node apps/telephony/dist/fake-twilio-call.js"`.
4. `npm install` so `package-lock.json` records `@fourpoints/telephony`.
5. `apps/telephony/Dockerfile`: replace its manifest `COPY` block with the one
   in `apps/realtime/Dockerfile`, plus
   `COPY apps/telephony/package.json apps/telephony/` (`npm ci` checks the
   whole monorepo lockfile). This is the only file edit.
6. Append the entries in `docs/decision-ledger-telephony.md` to
   `docs/architecture/decision-ledger.md`, and add the telephony service to
   `docs/architecture/current-state.md`.
7. Run the FourPoints gates: `npm run build`, `npm test`, `npm run lint`,
   `npm run format:check`, `npm audit --omit=dev`.

## Optional hardening after the move

- Verify the bearer token inside `apps/realtime` as well, so the telephony
  service can keep an application-level upgrade check (removes the documented
  exception in `docs/fourpoints-exposure.md`).
- Move the gateway's hosting into the FourPoints CDK stack.

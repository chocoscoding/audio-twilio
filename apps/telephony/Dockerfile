# FourPoints telephony gateway — same build pattern as apps/realtime/Dockerfile.
#
# Build from the repository root:
#   docker build -f apps/telephony/Dockerfile --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
#
# After moving into the FourPoints monorepo, the manifest COPY block must list
# every FourPoints workspace (see docs/migration.md) so `npm ci` matches the
# monorepo lockfile.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build
WORKDIR /build

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/telephony/package.json apps/telephony/
# Every workspace manifest must be present for `npm ci` to accept the lockfile.
COPY apps/telephony-demo/package.json apps/telephony-demo/

RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/telephony apps/telephony

# Service only: tests and the fake-twilio-call harness are excluded.
RUN npx tsc -b apps/telephony/tsconfig.build.json

RUN npm ci --workspaces --include-workspace-root --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runtime

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/package.json ./package.json
COPY --from=build --chown=node:node /build/apps/telephony/dist ./apps/telephony/dist
COPY --from=build --chown=node:node /build/apps/telephony/package.json ./apps/telephony/package.json
COPY --from=build --chown=node:node /build/packages ./packages

USER node

EXPOSE 8080

# node is PID 1 so SIGTERM reaches the drain handler directly.
CMD ["node", "apps/telephony/dist/index.js"]

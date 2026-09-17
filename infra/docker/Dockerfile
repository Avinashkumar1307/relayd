# syntax=docker/dockerfile:1.7

# One image, four process types (CLAUDE.md section 2: "One monorepo, one
# container image"). The process is chosen at run time by RELAYD_PROCESS, so
# staging and production run the exact same artifact in four roles.
#
# docs/10 shows one Dockerfile per app. The review's four-service topology and
# the Phase 0 checklist both call for a single image; this follows those.
#
# ARM64 (Graviton) per docs/10 — roughly 20% cheaper per vCPU. Build with:
#   docker buildx build --platform linux/arm64 -f infra/docker/Dockerfile .

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache dumb-init
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH


# ---- dependencies -----------------------------------------------------------
# Manifests are copied before sources so that a source-only change reuses the
# install layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json          apps/api/
COPY apps/edge/package.json         apps/edge/
COPY apps/scheduler/package.json    apps/scheduler/
COPY apps/web/package.json          apps/web/
COPY apps/worker/package.json       apps/worker/
COPY packages/analytics/package.json            packages/analytics/
COPY packages/audience/package.json             packages/audience/
COPY packages/billing/package.json              packages/billing/
COPY packages/campaigns/package.json            packages/campaigns/
COPY packages/config/package.json               packages/config/
COPY packages/db/package.json                   packages/db/
COPY packages/email-providers/package.json      packages/email-providers/
COPY packages/eslint-plugin-relayd/package.json packages/eslint-plugin-relayd/
COPY packages/logger/package.json               packages/logger/
COPY packages/notifications/package.json        packages/notifications/
COPY packages/queue/package.json                packages/queue/
COPY packages/testing/package.json              packages/testing/
COPY packages/types/package.json                packages/types/
COPY packages/utils/package.json                packages/utils/
COPY packages/validation/package.json           packages/validation/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile


# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm turbo run build

# Drop dev dependencies from the tree that ships.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod


# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

RUN addgroup -g 1001 app && adduser -S -u 1001 -G app app

COPY --from=build --chown=app:app /app/node_modules          ./node_modules
COPY --from=build --chown=app:app /app/package.json          ./package.json
COPY --from=build --chown=app:app /app/pnpm-workspace.yaml   ./pnpm-workspace.yaml

COPY --from=build --chown=app:app /app/apps/api/dist         ./apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=app:app /app/apps/edge/dist         ./apps/edge/dist
COPY --from=build --chown=app:app /app/apps/edge/package.json ./apps/edge/package.json
COPY --from=build --chown=app:app /app/apps/worker/dist         ./apps/worker/dist
COPY --from=build --chown=app:app /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=app:app /app/apps/scheduler/dist         ./apps/scheduler/dist
COPY --from=build --chown=app:app /app/apps/scheduler/package.json ./apps/scheduler/package.json

# packages/* dist and manifests: the apps resolve @relayd/* through them.
COPY --from=build --chown=app:app /app/packages ./packages

# Migrations ship in the image so the one-off migration task runs the same
# artifact as the services (docs/10: build once, promote the same digest).
COPY --from=build --chown=app:app /app/packages/db/migrations ./packages/db/migrations

COPY --chown=app:app infra/docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER app
EXPOSE 3000

# dumb-init is not optional: without PID-1 signal forwarding, SIGTERM never
# reaches Node and every deploy kills in-flight jobs after the Docker grace
# period (docs/10).
ENTRYPOINT ["dumb-init", "--", "/app/entrypoint.sh"]

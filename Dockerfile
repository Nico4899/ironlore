# syntax=docker/dockerfile:1.7
#
# Ironlore container image. Multi-stage so the runtime layer carries
# only what the server needs to execute — no dev deps, no test
# fixtures, no source maps.
#
# Build:
#   docker build -t ironlore .
# Run (compose handles this for you):
#   docker run --rm -p 127.0.0.1:3000:3000 -v ironlore-data:/data ironlore
#
# Native modules (better-sqlite3, sharp, @node-rs/argon2, node-pty)
# need to be built for the **runtime** architecture. We pin the
# Node major to 22 to match `engines.node` in the root package.json
# and let pnpm fetch prebuilds where available.

# ─────────────────────────────────────────────────────────────────
# Stage 1 — install workspace dependencies (cached on lockfile).
# ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /repo

# pnpm via corepack is the documented setup for this monorepo.
# Pinning the version matches the root `packageManager` field.
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

# Native build chain — better-sqlite3 + sharp can fall back to
# source compilation when no prebuild matches; without these the
# install step fails on uncommon distros / arches.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
      libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy only what's needed for `pnpm install` so the deps layer
# caches across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY biome.json tsconfig.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY apps/electron/package.json ./apps/electron/
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
COPY packages/create-ironlore/package.json ./packages/create-ironlore/

RUN pnpm install --frozen-lockfile

# ─────────────────────────────────────────────────────────────────
# Stage 2 — build the SPA (Vite) + worker (tsc).
# ─────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo

# Copy the source tree wholesale; deps/lockfile changes already
# invalidated the layer above.
COPY apps ./apps
COPY packages ./packages

# Build core + worker (tsc emit) and the SPA bundle (Vite). The
# server itself runs from source via `tsx` in the runtime stage —
# bundling the server is a follow-up.
RUN pnpm --filter @ironlore/core build && \
    pnpm --filter @ironlore/web build && \
    pnpm --filter @ironlore/worker build

# ─────────────────────────────────────────────────────────────────
# Stage 3 — minimal runtime. Carries only what the server needs.
# ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Same native runtime libs as the build stage minus the build
# toolchain. `libvips` is sharp's runtime dep; the rest of the
# native modules are statically self-contained.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips42 tini \
    && rm -rf /var/lib/apt/lists/*

# pnpm is required at runtime so we can shell into the image and
# invoke `pnpm exec ironlore lint --check ...` against the live
# install root, matching the documented operational surface in
# docs/07-tech-stack.md §Operational surface.
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

# Bring over the workspace as built in stage 2. We rely on tsx for
# server execution, so node_modules + source is enough.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps ./apps
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /repo/tsconfig.json ./tsconfig.json

# Runtime configuration. Everything here can be overridden by the
# operator via `docker run -e KEY=VALUE` or compose env.
ENV NODE_ENV=production
ENV IRONLORE_BIND=0.0.0.0
ENV IRONLORE_PORT=3000
ENV IRONLORE_INSTALL_ROOT=/data
ENV IRONLORE_SERVE_STATIC=/app/apps/web/dist/client
# `IRONLORE_TRUST_NETWORK_BIND=1` is the documented escape hatch
# (apps/web/src/server/network.ts) for container deployments where
# the network namespace + Docker port mapping are the trust
# boundary, not the in-process bind. Removing this without
# `IRONLORE_PUBLIC_URL=https://…` will fail validateBind at boot.
ENV IRONLORE_TRUST_NETWORK_BIND=1

# `/data` is the install root: projects/, jobs.sqlite,
# sessions.sqlite, ipc.token, password.salt, .ironlore-install.json.
# Mount a volume here in compose so user data + secrets survive
# container replacement.
VOLUME /data

EXPOSE 3000

# tini reaps zombies + forwards SIGTERM to the server so a `docker
# compose down` lets the WAL flush cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
# tsx lives at the workspace-root .bin in pnpm's hoisted layout.
# We `cd` into apps/web so process.cwd() seeds index.ts's relative
# resolution paths (Vite proxy targets, fetch-for-project, etc.)
# the same way the dev script does.
WORKDIR /app/apps/web
CMD ["/app/node_modules/.bin/tsx", "src/server/index.ts"]

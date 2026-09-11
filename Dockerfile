# syntax=docker/dockerfile:1

# ---- Stage 1: Base ----
FROM node:22-alpine AS base

ARG ALPINE_MIRROR=""
ARG NPM_REGISTRY=""

RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|$ALPINE_MIRROR|g" /etc/apk/repositories; \
    fi && \
    apk add --no-cache libc6-compat

RUN npm_registry="$NPM_REGISTRY"; \
    while [ "${npm_registry%/}" != "$npm_registry" ]; do \
      npm_registry="${npm_registry%/}"; \
    done; \
    if [ -n "$npm_registry" ]; then \
      export COREPACK_NPM_REGISTRY="$npm_registry"; \
    fi && \
    corepack enable && \
    corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

# ---- Stage 2: Dependencies ----
FROM base AS deps

ARG NPM_REGISTRY

# Native build tools for sharp, @napi-rs/canvas
RUN apk add --no-cache python3 build-base g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY scripts/ ./scripts/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    npm_registry="$NPM_REGISTRY"; \
    while [ "${npm_registry%/}" != "$npm_registry" ]; do \
      npm_registry="${npm_registry%/}"; \
    done; \
    if [ -n "$npm_registry" ]; then \
      pnpm config set registry "$npm_registry"; \
    fi && \
    pnpm install --frozen-lockfile

# ---- Stage 3: Builder ----
FROM base AS builder

ARG ALLOWED_FRAME_ANCESTORS
# Fork addition. The path this image serves under, read by next.config.ts for
# `basePath` and by lib/base-path.ts for the URLs the app writes itself. Both
# halves have to agree, which is why there is one variable and not two.
ARG NEXT_PUBLIC_STUDIO_BASE_PATH
ARG NEXT_PUBLIC_PERSISTENCE
ARG NEXT_PUBLIC_PERSISTENCE_TOKEN
ARG NEXT_PUBLIC_MAIC_EDITOR_ENABLED
ARG NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED
ARG NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED
ARG NEXT_PUBLIC_PI_CHAT_ENABLED
ARG NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI
ARG NEXT_PUBLIC_ENABLE_VIDEO_EXPORT
ARG NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION
ARG NEXT_PUBLIC_ENABLE_PPTX_IMPORT
ENV ALLOWED_FRAME_ANCESTORS=$ALLOWED_FRAME_ANCESTORS
ENV NEXT_PUBLIC_STUDIO_BASE_PATH=$NEXT_PUBLIC_STUDIO_BASE_PATH
ENV NEXT_PUBLIC_PERSISTENCE=$NEXT_PUBLIC_PERSISTENCE
ENV NEXT_PUBLIC_PERSISTENCE_TOKEN=$NEXT_PUBLIC_PERSISTENCE_TOKEN
ENV NEXT_PUBLIC_MAIC_EDITOR_ENABLED=$NEXT_PUBLIC_MAIC_EDITOR_ENABLED
ENV NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED=$NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED
ENV NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED=$NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED
ENV NEXT_PUBLIC_PI_CHAT_ENABLED=$NEXT_PUBLIC_PI_CHAT_ENABLED
ENV NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI=$NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI
ENV NEXT_PUBLIC_ENABLE_VIDEO_EXPORT=$NEXT_PUBLIC_ENABLE_VIDEO_EXPORT
ENV NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION=$NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION
ENV NEXT_PUBLIC_ENABLE_PPTX_IMPORT=$NEXT_PUBLIC_ENABLE_PPTX_IMPORT

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .
COPY --from=deps /app/public/vendor ./public/vendor

RUN pnpm build

# ---- Stage 4: Runner ----
FROM node:22-alpine AS runner

ARG ALPINE_MIRROR=""

# Fork addition, and it has to be here as well as in the builder. Next inlines
# NEXT_PUBLIC_* into the BROWSER bundle at build; server code still reads
# process.env at run time. This variable is read by both halves -- next.config's
# `basePath` and the client's apiPath() at build, and the persistence route's
# prefix arithmetic at run time -- so a builder-only value leaves the server
# thinking it is mounted at the origin root. The symptom is every persistence
# path answering ROUTE_NOT_FOUND while the pages themselves serve correctly.
ARG NEXT_PUBLIC_STUDIO_BASE_PATH
ENV NEXT_PUBLIC_STUDIO_BASE_PATH=$NEXT_PUBLIC_STUDIO_BASE_PATH

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN if [ -n "$ALPINE_MIRROR" ]; then \
      cp /etc/apk/repositories /tmp/apk.repositories; \
      sed -i "s|dl-cdn.alpinelinux.org|$ALPINE_MIRROR|g" /etc/apk/repositories; \
    fi && \
    apk add --no-cache libc6-compat cairo pango jpeg giflib librsvg && \
    if [ -n "$ALPINE_MIRROR" ]; then \
      mv /tmp/apk.repositories /etc/apk/repositories; \
    fi

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Fork addition. docker-compose.yml mounts a named volume here, and Docker
# seeds a fresh named volume with the ownership of the image path it covers --
# so when the path does not exist in the image, the mount point is created
# root-owned and `nextjs` cannot write its own data directory. Classrooms,
# materials and usage all land here; usage swallows the EACCES with a warning
# every few seconds, the others do not. A volume created before this line keeps
# its root ownership and needs a one-off `chown 1001:1001 /app/data`.
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# Fork addition. sharp needs libvips beside it, and the standalone tracer has
# already shipped one image without it (see next.config.ts). The runtime only
# notices at boot, in a log line, and then runs without its job runner. Make
# the build notice instead.
RUN node -e "require('sharp')"

EXPOSE 3000

CMD ["node", "server.js"]

# ---- build stage: compile TypeScript ----
FROM node:22-bookworm-slim AS build
ARG CONTEXTHUB_BUILD_COMMIT=unknown
ENV CONTEXTHUB_BUILD_COMMIT=$CONTEXTHUB_BUILD_COMMIT
# better-sqlite3 falls back to compiling from source when no prebuilt binary
# matches, so keep a toolchain available in the build stages.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- deps stage: production node_modules only ----
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ARG CONTEXTHUB_BUILD_COMMIT=unknown
ARG CONTEXTHUB_VERSION=unknown
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    CONTEXTHUB_BUILD_COMMIT=$CONTEXTHUB_BUILD_COMMIT
LABEL org.opencontainers.image.version=$CONTEXTHUB_VERSION \
      org.opencontainers.image.revision=$CONTEXTHUB_BUILD_COMMIT
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/index.js"]

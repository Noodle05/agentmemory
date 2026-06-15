ARG III_VERSION=0.11.2

FROM iiidev/iii:${III_VERSION} AS iii-image

FROM node:22-slim AS build
WORKDIR /app
COPY package.json tsconfig.json tsdown.config.ts ./
RUN npm install --package-lock-only --legacy-peer-deps --no-audit --no-fund
RUN npm ci --legacy-peer-deps --no-audit --no-fund
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

ARG III_VERSION=0.11.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini gosu curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=iii-image /app/iii /usr/local/bin/iii

WORKDIR /app
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

ENV AGENTMEMORY_III_VERSION=${III_VERSION} \
    TINI_SUBREAPER=1

COPY --chmod=0755 entrypoint.sh /app/entrypoint.sh

EXPOSE 3113 3114

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

ARG III_VERSION=0.11.2

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsdown.config.ts ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM iiidev/iii:${III_VERSION} AS iii-image

FROM node:22-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini curl \
 && rm -rf /var/lib/apt/lists/*
ARG III_VERSION
COPY --from=iii-image /app/iii /usr/local/bin/iii
WORKDIR /app
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY iii-config.docker.yaml ./iii-config.yaml
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
EXPOSE 3111 3112 3113 3114
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

FROM node:22.23.2-alpine AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/site/package.json apps/site/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile --filter @koyori/site...

COPY apps/site apps/site
COPY packages/core packages/core
COPY brand/logo.png brand/logo.png
COPY docs/releases docs/releases

RUN pnpm --filter @koyori/site build

FROM nginx:1.29.5-alpine

COPY apps/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/site/build/client /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz || exit 1

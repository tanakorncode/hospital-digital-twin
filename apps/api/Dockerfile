# API image (NestJS + socket.io + SQLite). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t hdt-api .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter api...
COPY apps/api apps/api
RUN pnpm --filter api build

FROM node:24-alpine
RUN corepack enable
ENV NODE_ENV=production PORT=4000
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter api... && pnpm store prune
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/scripts apps/api/scripts
WORKDIR /repo/apps/api
# The database lives on a volume: /repo/apps/api/data (see docker-compose.yml).
RUN mkdir -p data && chown -R node:node data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
CMD ["node", "dist/main"]

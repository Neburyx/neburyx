FROM node:24.22.2-bookworm-slim AS builder
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @neburyx/demo-graph build
RUN pnpm --filter @neburyx/demo-graph deploy --prod /out/demo-graph

FROM node:24.22.2-bookworm-slim
WORKDIR /app
COPY --from=builder /out/demo-graph/package.json ./tools/demo-graph/package.json
COPY --from=builder /out/demo-graph/node_modules ./tools/demo-graph/node_modules
COPY --from=builder /out/demo-graph/dist ./tools/demo-graph/dist
COPY --from=builder /repo/domain-packs ./domain-packs
RUN mkdir /config && chown node:node /config
USER node
WORKDIR /app/tools/demo-graph
ENTRYPOINT ["node", "dist/main.js"]

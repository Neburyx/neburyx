FROM node:24.22.2-bookworm-slim AS builder
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @neburyx/api deploy --prod /out/api

FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production \
    NEBURYX_HOST=0.0.0.0 \
    NEBURYX_CONTAINER=true \
    NEBURYX_WEB_ROOT=/app/web
WORKDIR /app
COPY --from=builder /out/api/package.json ./package.json
COPY --from=builder /out/api/node_modules ./node_modules
COPY --from=builder /out/api/dist ./dist
COPY --from=builder /out/api/migrations ./migrations
COPY --from=builder /repo/apps/web/dist ./web
COPY --from=builder /repo/LICENSE /repo/NOTICE /repo/THIRD-PARTY-NOTICES.md ./legal/
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["api"]

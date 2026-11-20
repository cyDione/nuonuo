FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/daemon ./apps/daemon
RUN pnpm install --frozen-lockfile && pnpm build
RUN pnpm --filter @nuonuo/daemon deploy --prod --legacy --config.node-linker=hoisted /out \
  && cp -R /app/apps/daemon/dist/. /out/ \
  && rm -rf /out/dist /out/src /out/tsconfig.json /out/tsdown.config.ts

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NUONUO_HOST=0.0.0.0 \
    NUONUO_PORT=7420 \
    NUONUO_HOME=/data \
    NUONUO_WEB=0 \
    NUONUO_SECRETS=file
COPY --from=build /out ./
RUN useradd -m -u 10001 nuonuo && mkdir -p /data && chown -R nuonuo:nuonuo /data
USER nuonuo
VOLUME ["/data"]
EXPOSE 7420
# Headless by default; set NUONUO_WEB=1 or pass `--web` to serve the built-in WebUI.
ENTRYPOINT ["node", "/app/cli.mjs"]
CMD ["start", "--no-open"]

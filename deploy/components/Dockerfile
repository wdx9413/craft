FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY bin ./bin
COPY core ./core
COPY capability ./capability
COPY adapters ./adapters
COPY assets ./assets
COPY deploy/components ./deploy/components
USER node
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "deploy/components/server.ts", "/config/config.json"]

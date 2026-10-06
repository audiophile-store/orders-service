FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/health`, { signal: AbortSignal.timeout(3000) }); process.exit(response.status === 200 ? 0 : 1);"]

CMD ["node", "dist/index.js"]
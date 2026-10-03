# syntax=docker/dockerfile:1
# Single-image build: API + web client in one service (used for Railway, where
# the free plan allows few services). The multi-container setup in
# docker-compose*.yml uses server/Dockerfile and client/Dockerfile instead.

FROM node:24-bookworm-slim AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM node:24-bookworm-slim AS server
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production LOG_FORMAT=json STATIC_DIR=/app/public
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=server /app/dist ./dist
COPY server/migrations ./migrations
COPY --from=client /client/dist ./public
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]

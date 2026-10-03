# syntax=docker/dockerfile:1

# ---- build (glibc image: the TypeScript 7 compiler ships native binaries) ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies only, non-root ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production LOG_FORMAT=json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 4000
# Migrations run on boot under an advisory lock (safe with several replicas).
CMD ["node", "dist/index.js"]

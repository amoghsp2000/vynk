# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# nginx serves the SPA, sets security headers and proxies /api + /ws to the
# API, so the app is same-origin (cookies stay SameSite=Strict, no CORS).
FROM nginx:1.27-alpine
# Rendered with envsubst at container start (PORT, API_UPSTREAM, MEDIA_ORIGIN, REAL_IP_FROM, RESOLVER).
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# RESOLVER 127.0.0.11 = Docker's embedded DNS (compose). Railway: [fd12::10].
ENV PORT=80 API_UPSTREAM=server:4000 MEDIA_ORIGIN=http://localhost:59000 REAL_IP_FROM=127.0.0.1/32 RESOLVER=127.0.0.11
EXPOSE 80

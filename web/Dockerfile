# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars are baked into the bundle at build time.
# Passed via docker-compose build.args.
ARG NEXT_PUBLIC_API_PORT=8000
ENV NEXT_PUBLIC_API_PORT=${NEXT_PUBLIC_API_PORT}

RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3020

# standalone output bundles only the files required to run the server.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static .next/static
COPY --from=builder /app/public public

EXPOSE 3020

CMD ["node", "server.js"]

# ProofLayer production image (Render Web Service + managed PostgreSQL).
#
# - Node 22 LTS (matches package.json engines)
# - Reproducible install from package-lock.json
# - Prisma Client generated at build time
# - TypeScript compiled to dist/
# - Runs as non-root; no .env or secrets baked in (see .dockerignore)
# - No database access at build time. At container start, pending Prisma
#   migrations apply first (npx prisma migrate deploy), then the server
#   starts (node dist/main.js). Never migrate dev / db push / db pull here.

# ---------- build stage ----------
FROM node:22-slim AS builder

# Toolchain for native modules (argon2) — build stage only.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY public ./public
COPY src ./src

RUN npx prisma generate && npm run build

# ---------- runtime stage ----------
FROM node:22-slim AS runtime

# Prisma engines need OpenSSL at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r app && useradd -r -g app app

WORKDIR /app
ENV NODE_ENV=production

# node_modules are carried over whole (incl. the Prisma CLI) so that
# `npx prisma migrate deploy` works at container start without network.
# .dockerignore guarantees no .env or secrets enter the image.
COPY --chown=app:app --from=builder /app/node_modules ./node_modules
COPY --chown=app:app --from=builder /app/dist ./dist
COPY --chown=app:app --from=builder /app/public ./public
COPY --chown=app:app --from=builder /app/prisma ./prisma
COPY --chown=app:app --from=builder /app/package.json ./package.json
COPY --chown=app:app --from=builder /app/package-lock.json ./package-lock.json

USER app
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]

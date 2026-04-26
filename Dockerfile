# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
# Install ALL deps (including devDeps like typescript, ts-node) for compilation
RUN npm install --prefer-offline

COPY . .
# Generate Prisma client
RUN npx prisma generate
# Compile TypeScript → dist/
RUN npx tsc --outDir dist

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy only production node_modules (no devDeps in runtime)
COPY package*.json ./
RUN npm install --omit=dev --prefer-offline

# Copy compiled JS and Prisma artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

ENV NODE_ENV=production
ENV PORT=8080
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1
EXPOSE 8080
CMD ["node", "dist/index.js"]

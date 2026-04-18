FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
# Fix: package-lock.json is missing, so we use npm install instead of npm ci
RUN npm install --omit=dev --prefer-offline
COPY . .
RUN npx prisma generate
# Optional: add build step if needed
# RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
# Fix: install curl for healthcheck and ensure mirrors work
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /app .
ENV NODE_ENV=production
ENV PORT=3001
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1
EXPOSE 3001
# Note: In production it's better to use compiled JS, but keeping ts-node for this setup
CMD ["npx", "ts-node", "src/index.ts"]

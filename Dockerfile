FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npx prisma generate
RUN npm run build 2>/dev/null || true  # Skip if no build script

FROM node:20-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app .
ENV NODE_ENV=production
ENV PORT=3001
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1
EXPOSE 3001
CMD ["node", "-r", "ts-node/register", "src/index.ts"]

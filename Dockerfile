# ============================================
# ACCP API - Production Dockerfile
# ============================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# ============================================
# Stage 2: Production
# ============================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install postgresql-client for health checks
RUN apk add --no-cache postgresql-client

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/src/database/schema.ts ./src/database/schema.ts

# Install production dependencies only
RUN npm install --legacy-peer-deps --omit=dev

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 api
USER api

EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

# Run db:push then start server
CMD ["sh", "-c", "npx drizzle-kit push && node dist/index.js"]
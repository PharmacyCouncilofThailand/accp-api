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

# Install postgresql-client for health checks, Chromium for puppeteer,
# LibreOffice for DOCX→PDF conversion (invitation letter), and Thai fonts
# so Thai/embedded fonts render correctly inside the generated PDF.
RUN apk add --no-cache \
    postgresql-client \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    libreoffice \
    libreoffice-common \
    msttcorefonts-installer \
    fontconfig \
    && update-ms-fonts \
    && fc-cache -f \
    && rm -rf /var/cache/apk/*

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/src/database/schema.ts ./src/database/schema.ts

# Install production dependencies only
RUN npm install --legacy-peer-deps --omit=dev

# Copy font files for PDF receipt generation (PDFKit)
COPY --from=builder /app/public/Font ./public/Font

# Create public directory for uploads (before switching to non-root user)
RUN mkdir -p /app/public/uploads

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 api
RUN chown -R api:nodejs /app/public
USER api

EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

# Run server (run db:push manually via DBeaver or Railway CLI)
CMD ["node", "dist/index.js"]
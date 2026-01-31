# ═══════════════════════════════════════════════════════════════════════════════
# CarniTrack Edge Service - Docker Image
# ═══════════════════════════════════════════════════════════════════════════════
# Multi-stage build for optimized production image
# Base: oven/bun (official Bun image)
# ═══════════════════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────────────────────
# Stage 1: Install dependencies
# ─────────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS dependencies

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies (production only)
RUN bun install --frozen-lockfile --production

# ─────────────────────────────────────────────────────────────────────────────────
# Stage 2: Build (if needed)
# ─────────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files and install all deps (including dev)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Type check
RUN bun run typecheck

# ─────────────────────────────────────────────────────────────────────────────────
# Stage 3: Production runtime
# ─────────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 carnitrack && \
    adduser --system --uid 1001 --ingroup carnitrack carnitrack

# Create directories for data persistence
RUN mkdir -p /app/data /app/logs /app/generated && \
    chown -R carnitrack:carnitrack /app

# Copy production dependencies
COPY --from=dependencies /app/node_modules ./node_modules

# Copy source code (Bun runs TypeScript directly)
COPY --chown=carnitrack:carnitrack package.json ./
COPY --chown=carnitrack:carnitrack tsconfig.json ./
COPY --chown=carnitrack:carnitrack src ./src

# Switch to non-root user
USER carnitrack

# ─────────────────────────────────────────────────────────────────────────────────
# Environment Configuration
# ─────────────────────────────────────────────────────────────────────────────────
# TCP Server (scales connect here)
ENV TCP_PORT=8899
ENV TCP_HOST=0.0.0.0

# HTTP Server (admin dashboard)
ENV HTTP_PORT=3000
ENV HTTP_HOST=0.0.0.0

# Database (SQLite)
ENV DB_PATH=/app/data/carnitrack.db

# Cloud REST API
ENV CLOUD_API_URL=https://api.carnitrack.com/api/v1/edge

# Logging
ENV LOG_LEVEL=info
ENV NODE_ENV=production

# ─────────────────────────────────────────────────────────────────────────────────
# Expose Ports
# ─────────────────────────────────────────────────────────────────────────────────
# 3000 - HTTP Admin Dashboard
# 8899 - TCP Server for DP-401 Scales
EXPOSE 3000 8899

# ─────────────────────────────────────────────────────────────────────────────────
# Health Check
# ─────────────────────────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD bun --eval "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || exit 1

# ─────────────────────────────────────────────────────────────────────────────────
# Start
# ─────────────────────────────────────────────────────────────────────────────────
CMD ["bun", "run", "src/index.ts"]

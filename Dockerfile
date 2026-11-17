# syntax=docker/dockerfile:1

# ---- build: install all dependencies, generate the Prisma client, compile TypeScript ----
# The same image runs the API (default command), the worker (... worker) and, locally, the test receiver.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# Runs `prisma generate` through the postinstall script.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY receiver ./receiver
RUN npm run build

# ---- runtime: production dependencies and compiled output only ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# The official image ships an unprivileged "node" user.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" > /dev/null || exit 1
CMD ["node", "dist/scripts/start-with-secrets.js"]

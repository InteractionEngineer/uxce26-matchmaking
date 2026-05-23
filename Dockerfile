# Build stage — compiles better-sqlite3 native bindings
FROM node:20-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Runtime stage — lean image, no build tools
FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .
RUN mkdir -p /data && chown app:app /data
USER app
EXPOSE 3000
ENV DATA_DIR=/data NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/sessions > /dev/null || exit 1
CMD ["node", "server.js"]

# Netwrth — self-hosted, één container (amd64)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 levert kant-en-klare binaries mee (prebuilds/, o.a. linux-x64) en laadt die eerst.
# Zonder --ignore-scripts compileert npm hem toch, en daarvoor mist deze slanke image python en g++.
# De tweede regel laat de build falen als de binary niet laadt op het doelplatform.
RUN npm ci --ignore-scripts \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner
LABEL org.opencontainers.image.source=https://github.com/PassyP/netwrth
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 DATA_DIR=/data TZ=Europe/Amsterdam
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/drizzle ./drizzle
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

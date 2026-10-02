# Taskasaur's application image augments the pinned official Supabase Compose stack.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts/native-prepare.mjs ./scripts/native-prepare.mjs
RUN npm ci && node -e "require('node-pty')"

FROM dependencies AS build
COPY . .
RUN npm run typecheck && npm run core:verify && npm run build:web -- --webpack

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ARG TASKASAUR_VERSION=0.2.0
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Taskasaur" \
      org.opencontainers.image.version=$TASKASAUR_VERSION \
      org.opencontainers.image.revision=$SOURCE_REVISION
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next/standalone ./.next/standalone
COPY --from=build /app/.next/static ./.next/standalone/.next/static
COPY --from=build /app/public ./.next/standalone/public
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/packages ./packages
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/scripts ./scripts
RUN mkdir -p /var/lib/taskasaur/plugins /var/lib/taskasaur/office && chown -R node:node /var/lib/taskasaur
USER node
EXPOSE 3000 8787
CMD ["node", ".next/standalone/server.js"]

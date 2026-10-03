FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY packages/platform/package.json ./packages/platform/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts && npm rebuild node-pty
COPY . .
ARG VITE_PLUGIN_INVENTORY_URL
ENV VITE_PLUGIN_INVENTORY_URL=$VITE_PLUGIN_INVENTORY_URL
RUN npm run build
RUN npm prune --omit=dev --omit=peer --ignore-scripts

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /data && chown node:node /data
WORKDIR /app
ARG TASKASAUR_VERSION=0.3.0
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Taskasaur peer" \
      org.opencontainers.image.version=$TASKASAUR_VERSION \
      org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production TASKASAUR_DATA=/data TASKASAUR_HOST=0.0.0.0 TASKASAUR_RELAY=1 OFFICE_ASSET_PATH=/app/office-engine
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-peer ./dist-peer
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/platform ./packages/platform
COPY --from=build /app/package.json ./package.json
USER node
VOLUME /data
EXPOSE 8080 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist-peer/main.js"]

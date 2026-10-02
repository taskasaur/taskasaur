FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts
COPY . .
ARG VITE_PLUGIN_INVENTORY_URL
ENV VITE_PLUGIN_INVENTORY_URL=$VITE_PLUGIN_INVENTORY_URL
RUN npm run typecheck && npm run build:web

FROM nginx:1.28-alpine
ARG TASKASAUR_VERSION=0.2.0
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Taskasaur client" \
      org.opencontainers.image.version=$TASKASAUR_VERSION \
      org.opencontainers.image.revision=$SOURCE_REVISION
ENV TASKASAUR_SERVER_URL=http://host.docker.internal:3000
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/docker/nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -q --spider http://127.0.0.1:8080/ || exit 1

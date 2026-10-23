FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public

RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8

USER root
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx-temp-dirs.sh /docker-entrypoint.d/40-temp-dirs.sh
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod 755 /docker-entrypoint.d/40-temp-dirs.sh
USER nginx

EXPOSE 8080

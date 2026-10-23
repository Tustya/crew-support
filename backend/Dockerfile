FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY migrations ./migrations
COPY docker-entrypoint.sh ./docker-entrypoint.sh

ENV HOST=0.0.0.0 \
    PORT=8080 \
    NODE_ENV=development

EXPOSE 8080

USER node

CMD ["sh", "docker-entrypoint.sh"]

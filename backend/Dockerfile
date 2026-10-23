FROM node:22-bookworm-slim

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

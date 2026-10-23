# Технологии

- Интерфейс: React 19, Vite, Tailwind 4, React Router. Прокси `/api` на API.
- API: Node.js, TypeScript, единственная runtime-зависимость `pg`. HTTP без фреймворка.
- База: PostgreSQL 18. Локально порт `127.0.0.1:54329`.
- Тесты API: `node:test`. Тесты интерфейса: Vitest.
- Контейнеры: `compose.yaml`, nginx отдаёт собранный интерфейс и проксирует `/api`.

Новые runtime-зависимости не добавлять без отдельного решения. Хеш пароля — `node:crypto` `scrypt`.

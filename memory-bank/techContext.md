# Технологии

- Интерфейс: React 19, Vite, Tailwind 4, React Router. Прокси `/api` на API.
- API: Node.js 26, TypeScript, единственная runtime-зависимость `pg`. HTTP без фреймворка.
- База: PostgreSQL 18. Локально порт `127.0.0.1:54329`. В Compose роли `crew_migrator` и `crew_app`, init-скрипт только на пустом томе.
- Тесты API: `node:test`. Тесты интерфейса: Vitest 5, окружение `node`.
- Контейнеры: `compose.yaml`, образы закреплены digest. nginx-unprivileged отдаёт интерфейс на 8080 и проксирует `/api`. API и web: `read_only`, `cap_drop: ALL`, `no-new-privileges`.
- CI: `.github/workflows/ci.yml` — тесты, `npm audit`, gitleaks, CycloneDX SBOM. Actions закреплены по SHA.

Новые runtime-зависимости не добавлять без отдельного решения. Хеш пароля — `node:crypto` `scrypt`.

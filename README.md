# Crew Support · гостиницы

Рабочее место смены. Интерфейс ходит в локальный API. Почта и Aviabit в production выключены.

## Запуск

Нужны Node.js 22+ и PostgreSQL на `127.0.0.1:54329` (контейнер `crew-support-pg`).

```bash
cd backend
npm install
npm run migrate
npm run seed
DATABASE_URL=postgres://crew:crew@127.0.0.1:54329/crew_support AUTH_MODE=mock SOURCE_ADAPTER=sample MAIL_ADAPTER=disabled PORT=8081 npm start
```

```bash
npm install
npm run dev
```

Откройте http://127.0.0.1:5173/ и войдите как специалист или старший смены. Роль отдаёт `GET /api/v1/me`. Выгрузки: `backend/fixtures/01-initial.xlsx`, затем `backend/fixtures/02-changes.xlsx`. В файлах есть колонки «Идентификатор брони» и «Код гостиницы» (`angel`, `bereg`). Без них строка не попадает в очередь.

## Docker

Локальный контур целиком: PostgreSQL 18, API и собранный интерфейс за nginx. Это не production: mock-вход, sample-источник и пароль `crew:crew` там не стартуют.

```bash
docker compose up --build
```

Откройте http://127.0.0.1:8080/ и войдите как специалист или старший смены. Выгрузки по-прежнему `backend/fixtures/01-initial.xlsx`, затем `backend/fixtures/02-changes.xlsx` — их выбирают в интерфейсе.

API слушает `0.0.0.0` только внутри сети Compose, с хоста доступен порт `127.0.0.1:8080`. При первом старте применяются миграции и справочник. Повторный запуск справочник не перезаписывает.

```bash
docker compose down
```

Данные базы лежат в volume `crew_support_pg`. `docker compose down -v` удаляет их.

## Проверки и сборка

```bash
npm test
npm run build
npm run preview
```

`npm run build` кладёт сайт в `dist/`. `npm run preview` показывает эту сборку локально.

## Локальный API

Интерфейс проксирует `/api` на `127.0.0.1:8081`. API слушает только localhost.

PostgreSQL:

```bash
docker run -d --name crew-support-pg -p 127.0.0.1:54329:5432 \
  -e POSTGRES_USER=crew -e POSTGRES_PASSWORD=crew -e POSTGRES_DB=crew_support \
  postgres:18-alpine
```

```bash
cd backend
cp .env.example .env
npm install
npm run migrate
npm run seed
npm start
```

`npm test` в `backend/` гоняет домен и HTTP против `crew_support_test` на том же порту. Контракт — `backend/openapi.yaml`. В production процесс не стартует с mock-входом, sample-источником и почтой.

## Границы

В сессии браузера хранится только субъект входа, не экипаж и не письма. Файл без согласованной шапки отклоняется. Почтовый шлюз выключен: письмо передаётся наружу и подтверждается вручную. В production mock-вход не стартует.

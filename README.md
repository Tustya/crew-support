# Crew Support · гостиницы

Рабочее место смены. Интерфейс ходит в локальный API. Почта и Aviabit в production выключены.

## Запуск

Нужны Node.js 22+ и PostgreSQL на `127.0.0.1:54329` (контейнер `crew-support-pg`).

```bash
cd backend
npm install
npm run migrate
npm run seed
DATABASE_URL=postgres://crew:crew@127.0.0.1:54329/crew_support AUTH_MODE=password AUTH_PEPPER=dev-only-pepper-change-me-000000 COOKIE_SECURE=false SOURCE_ADAPTER=sample MAIL_ADAPTER=disabled PORT=8081 npm start
```

```bash
npm install
npm run dev
```

Откройте http://127.0.0.1:5173/ и войдите почтой. Роль отдаёт `GET /api/v1/me`.

- Старший смены: `lead@crew-support.local`, Соколов Андрей Викторович
- Специалист смены: `specialist@crew-support.local`, Орлова Елена Павловна
- Пароль обеих ролей: `8e9sVY7Ji1xoZxRL2ZU6`

Выгрузки: `backend/fixtures/01-initial.xlsx`, затем `backend/fixtures/02-changes.xlsx`. В файлах есть колонки «Идентификатор брони» и «Код гостиницы» (`angel`, `bereg`). Без них строка не попадает в очередь.

## Docker

Локальный контур целиком: PostgreSQL 18, API и собранный интерфейс за nginx. Это не production: dev-перец, sample-источник и пароль `crew:crew` там не стартуют.

```bash
docker compose up --build
```

Откройте http://127.0.0.1:8080/ и войдите почтой `lead@crew-support.local` или `specialist@crew-support.local`, пароль `8e9sVY7Ji1xoZxRL2ZU6`. Выгрузки по-прежнему `backend/fixtures/01-initial.xlsx`, затем `backend/fixtures/02-changes.xlsx` — их выбирают в интерфейсе.

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

`npm test` в `backend/` гоняет домен и HTTP против `crew_support_test` на том же порту. Контракт — `backend/openapi.yaml`. В production процесс не стартует с mock-входом, dev-перцем, sample-источником и почтой.

## Границы

Сессия хранится в HttpOnly cookie, не в `localStorage`. Экипаж и письма туда не пишутся. Файл без согласованной шапки отклоняется. Почтовый шлюз выключен: письмо передаётся наружу и подтверждается вручную. В production mock-вход не стартует.

# Transfer Files

Нужно было часто передавать тяжёлые файлы между устройствами. В мессенджерах это долго, а публичные обменники — нельзя. **Transfer Files** — свой закрытый обмен на VPS: один пароль, загрузки до десятков ГБ, ссылка на файл/папку, срок хранения.

## Frontend

- **React + Vite + TypeScript**
- Слои: `app` → `pages` → `widgets` → `modules` → `shared` (импорты только вниз)
- Одна страница: вход, список, модалка создания, модалка item (`?id=`)
- Чанковая загрузка (resume после обрыва, отмена), папки как дерево
- «Скачать всё» в папку с именем передачи (File System Access + fallback) и опционально один zip **без сжатия** (STORE)

## Backend

- **Node.js / Express** + **PostgreSQL** + файлы на диске
- Сессия по общему паролю (cookie), API чанков upload/complete/abort, превью и скачивание
- TTL загрузок, GC незавершённых upload, очистка по расписанию
- На сервере: PM2 + nginx reverse proxy на path `/file-transfer/`

## Запуск на сервере

Нужны Node.js ≥ 20, PostgreSQL, nginx (по желанию).

```bash
# в каталоге проекта
cp .env.example .env   # заполни значения (секреты только в .env, не в git)
npm install
npm run build
npm start
# или: pm2 start server.js --name file-transfer && pm2 save
```

Параметры окружения — только в **`.env.example`** (скопируй в `.env`). В README секреты не перечисляем.

Nginx: проксируй на `PORT` из `.env`, для больших загрузок подними `client_max_body_size` и таймауты, `proxy_request_buffering off`.

# Transfer Files

Secure shared file-exchange UI at `/file-transfer` on the VPS.

## Features

- Shared password login (httpOnly Secure session cookie)
- Upload file or folder (preserved as a file tree)
- Retention: 1 hour / 24 hours (default) / 3 days / 7 days
- Max upload size: 20 GB (streaming to disk)
- List, preview, rename, delete, copy share link, download
- Expired items purged every ~3 minutes

## Env

Copy `.env.example` → `.env` (mode 600). Required:

- `PORT=3060`
- `BASE_PATH=/file-transfer`
- `AUTH_PASSWORD`
- `SESSION_SECRET` (≥32 chars)
- `DATABASE_URL`
- `STORAGE_DIR=/var/lib/file-transfer/storage`
- `MAX_UPLOAD_BYTES=21474836480`
- `NODE_ENV=production`
- `TRUST_PROXY=1`

## Run

```bash
npm ci --omit=dev
pm2 start server.js --name file-transfer
pm2 save
```

## nginx

Place **before** `location /`:

```nginx
location /file-transfer/ {
    proxy_pass http://127.0.0.1:3060/file-transfer/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 20g;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 60s;
}
location = /file-transfer {
    return 301 /file-transfer/;
}
```

Then `nginx -t && systemctl reload nginx`.

## Frontend

React + Vite + TypeScript. Source in `src/`, build output in `dist/`.

```bash
npm install
npm run build   # writes dist/
npm start       # Express serves dist/ under BASE_PATH
```

Layers: `app` → `pages` → `widgets` → `modules` → `shared` (unidirectional imports).
## Source of truth

Development source of truth: `/opt/file-transfer` on the VPS.

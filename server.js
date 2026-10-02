'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Busboy = require('busboy');
const mime = require('mime-types');
const archiver = require('archiver');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { randomUUID } = require('crypto');

const { getPool, migrate } = require('./lib/db');
const { startCleanupJob, deleteItemFiles } = require('./lib/cleanup');
const { sanitizeRelativePath, fixUtf8Filename, storagePathFor, itemDir } = require('./lib/paths');
const { registerUploadRoutes } = require('./lib/uploadRoutes');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function positiveNumber(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function durationFromEnv(unitName, msName, unitMs, fallbackMs) {
  const unitValue = positiveNumber(process.env[unitName]);
  if (unitValue !== null) return unitValue * unitMs;
  const msValue = positiveNumber(process.env[msName]);
  return msValue !== null ? msValue : fallbackMs;
}

const PORT = Number(process.env.PORT || 3060);
const BASE_PATH = (process.env.BASE_PATH || '/file-transfer').replace(/\/$/, '') || '';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024 * 1024);
const STORAGE_DIR = process.env.STORAGE_DIR || '/var/lib/file-transfer/storage';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE_MS = durationFromEnv('SESSION_DAYS', 'SESSION_MAX_AGE_MS', DAY_MS, 14 * DAY_MS);
const UPLOAD_GC_TTL_MS = durationFromEnv('UPLOAD_GC_HOURS', 'UPLOAD_GC_TTL_MS', HOUR_MS, 24 * HOUR_MS);
const CLEANUP_INTERVAL_MS = durationFromEnv(
  'CLEANUP_INTERVAL_MINUTES',
  'CLEANUP_INTERVAL_MS',
  MINUTE_MS,
  3 * MINUTE_MS
);
const CHUNK_SIZE = positiveNumber(process.env.CHUNK_SIZE) || 8 * 1024 * 1024;

const RETENTION = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

let passwordHash;

function requireEnv() {
  const missing = [];
  if (!AUTH_PASSWORD) missing.push('AUTH_PASSWORD');
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) missing.push('SESSION_SECRET');
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length) {
    console.error('Missing or invalid env:', missing.join(', '));
    process.exit(1);
  }
}

function formatBytes(n) {
  const num = Number(n) || 0;
  if (num < 1024) return `${num} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = num;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}



function publicItemUrl(slug, req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${BASE_PATH}/?id=${encodeURIComponent(slug)}`;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function isPreviewableMime(m) {
  if (!m) return false;
  if (m.startsWith('image/')) return true;
  if (m.startsWith('video/')) return true;
  if (m === 'application/pdf') return true;
  if (m.startsWith('text/')) return true;
  if (
    [
      'application/json',
      'application/javascript',
      'application/xml',
      'application/x-javascript',
    ].includes(m)
  ) {
    return true;
  }
  return false;
}

async function main() {
  requireEnv();
  process.env.STORAGE_DIR = STORAGE_DIR;

  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  passwordHash = await bcrypt.hash(AUTH_PASSWORD, 12);

  await migrate();
  startCleanupJob(CLEANUP_INTERVAL_MS, UPLOAD_GC_TTL_MS);
  console.log(
    `[config] sessionMaxAgeMs=${SESSION_MAX_AGE_MS} uploadGcTtlMs=${UPLOAD_GC_TTL_MS} cleanupIntervalMs=${CLEANUP_INTERVAL_MS} chunkSize=${CHUNK_SIZE}`
  );

  const app = express();
  if (process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", "'unsafe-inline'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", 'data:', 'blob:'],
          "media-src": ["'self'", 'blob:'],
          "frame-src": ["'self'", 'blob:'],
          "connect-src": ["'self'"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(express.json({ limit: '2mb' }));

  const pool = getPool();

  app.use(
    session({
      store: new pgSession({
        pool,
        tableName: 'session',
        createTableIfMissing: false,
      }),
      name: 'ft.sid',
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE_MS,
        path: BASE_PATH || '/',
      },
    })
  );

  const router = express.Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, try later' },
  });

  router.get('/api/me', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
  });

  router.post('/api/login', loginLimiter, async (req, res) => {
    try {
      const password = req.body && req.body.password;
      if (typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Password required' });
      }
      const ok = await bcrypt.compare(password, passwordHash);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid password' });
      }
      req.session.authenticated = true;
      req.session.save((err) => {
        if (err) {
          console.error('session save', err);
          return res.status(500).json({ error: 'Session error' });
        }
        return res.json({ ok: true });
      });
    } catch (err) {
      console.error('login', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('ft.sid', { path: BASE_PATH || '/' });
      res.json({ ok: true });
    });
  });

  router.get('/api/items', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, title, kind, expires_at, created_at, size_bytes, mime, original_name
         FROM items
         WHERE expires_at > NOW()
         ORDER BY created_at DESC`
      );
      res.json({
        items: rows.map((r) => ({
          ...r,
          size_label: formatBytes(r.size_bytes),
          url: `${BASE_PATH}/?id=${encodeURIComponent(r.slug)}`,
        })),
      });
    } catch (err) {
      console.error('list items', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/items/:slug', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, title, kind, expires_at, created_at, size_bytes, mime, original_name
         FROM items WHERE slug = $1 AND expires_at > NOW()`,
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const item = rows[0];
      const files = await pool.query(
        `SELECT id, relative_path, size_bytes, mime
         FROM item_files WHERE item_id = $1 ORDER BY relative_path`,
        [item.id]
      );
      res.json({
        item: {
          ...item,
          size_label: formatBytes(item.size_bytes),
          url: publicItemUrl(item.slug, req),
          path_url: `${BASE_PATH}/?id=${encodeURIComponent(item.slug)}`,
        },
        files: files.rows.map((f) => ({
          ...f,
          size_label: formatBytes(f.size_bytes),
        })),
      });
    } catch (err) {
      console.error('get item', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.patch('/api/items/:slug', requireAuth, async (req, res) => {
    try {
      const title = req.body && req.body.title;
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) {
        return res.status(400).json({ error: 'Invalid title' });
      }
      const { rows } = await pool.query(
        `UPDATE items SET title = $1
         WHERE slug = $2 AND expires_at > NOW()
         RETURNING id, slug, title, kind, expires_at, created_at, size_bytes, mime, original_name`,
        [title.trim(), req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ item: rows[0] });
    } catch (err) {
      console.error('rename', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.delete('/api/items/:slug', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM items WHERE slug = $1 RETURNING id`,
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      await deleteItemFiles(rows[0].id);
      res.json({ ok: true });
    } catch (err) {
      console.error('delete', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  registerUploadRoutes(router, {
    pool,
    requireAuth,
    RETENTION,
    MAX_UPLOAD_BYTES,
    BASE_PATH,
    publicItemUrl,
    DEFAULT_CHUNK_SIZE: CHUNK_SIZE,
  });

  // Legacy single-shot multipart (kept as fallback; UI uses chunked /api/uploads)
  router.post('/api/items', requireAuth, (req, res) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }

    const itemId = randomUUID();
    const dir = itemDir(itemId);
    let title = '';
    let retention = '24h';
    let totalBytes = 0;
    let aborted = false;
    const fileRecords = [];
    const writePromises = [];

    const finishError = async (status, message) => {
      if (aborted) return;
      aborted = true;
      try {
        req.unpipe();
      } catch (_) {}
      try {
        await fsp.rm(dir, { recursive: true, force: true });
      } catch (_) {}
      if (!res.headersSent) {
        res.status(status).json({ error: message });
      }
    };

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 50000,
          fields: 20,
          fieldSize: 16 * 1024,
        },
      });
    } catch (err) {
      return res.status(400).json({ error: 'Invalid multipart request' });
    }

    fsp
      .mkdir(dir, { recursive: true })
      .then(() => {
        busboy.on('field', (name, val) => {
          if (name === 'title') title = fixUtf8Filename(String(val || '')).trim().slice(0, 200);
          if (name === 'retention') retention = String(val || '24h');
        });

        busboy.on('file', (name, fileStream, info) => {
          if (aborted) {
            fileStream.resume();
            return;
          }
          if (name !== 'files') {
            fileStream.resume();
            return;
          }

          const filename = fixUtf8Filename(info.filename || 'file');
          const relative = sanitizeRelativePath(filename);
          if (!relative) {
            fileStream.resume();
            finishError(400, `Invalid file path: ${filename}`);
            return;
          }

          const storageName = `${randomUUID()}${path.extname(relative).slice(0, 64)}`;
          const dest = storagePathFor(itemId, storageName);
          const mimeType = info.mimeType || mime.lookup(relative) || 'application/octet-stream';
          const out = fs.createWriteStream(dest);
          let fileSize = 0;

          const rec = {
            id: randomUUID(),
            relative_path: relative,
            size_bytes: 0,
            mime: mimeType,
            storage_name: storageName,
          };
          fileRecords.push(rec);

          const p = new Promise((resolve, reject) => {
            fileStream.on('data', (chunk) => {
              fileSize += chunk.length;
              totalBytes += chunk.length;
              if (totalBytes > MAX_UPLOAD_BYTES) {
                fileStream.unpipe(out);
                out.destroy();
                fileStream.resume();
                finishError(413, 'Upload exceeds 20 GB limit');
                reject(new Error('too large'));
                return;
              }
            });
            fileStream.on('error', reject);
            out.on('error', reject);
            out.on('finish', () => {
              rec.size_bytes = fileSize;
              resolve();
            });
            fileStream.pipe(out);
          });
          writePromises.push(p.catch((err) => {
            if (!aborted) finishError(500, 'Upload failed');
            throw err;
          }));
        });

        busboy.on('error', (err) => {
          console.error('busboy', err);
          finishError(400, 'Upload parse error');
        });

        busboy.on('finish', async () => {
          if (aborted) return;
          try {
            await Promise.all(writePromises);
            if (aborted) return;

            if (!fileRecords.length) {
              return finishError(400, 'No files uploaded');
            }
            if (!RETENTION[retention]) {
              return finishError(400, 'Invalid retention');
            }
            if (!title) {
              // default title from first file / folder root
              const first = fileRecords[0].relative_path;
              if (fileRecords.length === 1) {
                title = path.posix.basename(first);
              } else {
                const root = first.split('/')[0];
                const sameRoot = fileRecords.every((f) => f.relative_path.split('/')[0] === root);
                title = sameRoot && first.includes('/') ? root : `Upload (${fileRecords.length} files)`;
              }
            }

            const kind =
              fileRecords.length === 1 && !fileRecords[0].relative_path.includes('/')
                ? 'file'
                : 'folder';
            const expiresAt = new Date(Date.now() + RETENTION[retention]);
            let slug = nanoid(10);
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              // rare slug collision retry
              for (let i = 0; i < 5; i++) {
                try {
                  await client.query(
                    `INSERT INTO items (id, slug, title, kind, expires_at, size_bytes, mime, original_name)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [
                      itemId,
                      slug,
                      title,
                      kind,
                      expiresAt,
                      totalBytes,
                      kind === 'file' ? fileRecords[0].mime : null,
                      kind === 'file' ? fileRecords[0].relative_path : null,
                    ]
                  );
                  break;
                } catch (e) {
                  if (e.code === '23505' && i < 4) {
                    slug = nanoid(10);
                    continue;
                  }
                  throw e;
                }
              }
              for (const f of fileRecords) {
                await client.query(
                  `INSERT INTO item_files (id, item_id, relative_path, size_bytes, mime, storage_name)
                   VALUES ($1,$2,$3,$4,$5,$6)`,
                  [f.id, itemId, f.relative_path, f.size_bytes, f.mime, f.storage_name]
                );
              }
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            } finally {
              client.release();
            }

            res.status(201).json({
              item: {
                id: itemId,
                slug,
                title,
                kind,
                expires_at: expiresAt.toISOString(),
                size_bytes: totalBytes,
                size_label: formatBytes(totalBytes),
                url: publicItemUrl(slug, req),
                path_url: `${BASE_PATH}/?id=${encodeURIComponent(slug)}`,
              },
            });
          } catch (err) {
            console.error('create item', err);
            await finishError(500, 'Failed to save upload');
          }
        });

        req.pipe(busboy);
      })
      .catch((err) => {
        console.error('mkdir', err);
        res.status(500).json({ error: 'Storage error' });
      });
  });


  async function resolveFile(slug, fileId) {
    const { rows } = await pool.query(
      `SELECT f.id, f.relative_path, f.size_bytes, f.mime, f.storage_name, i.id AS item_id
       FROM item_files f
       JOIN items i ON i.id = f.item_id
       WHERE i.slug = $1 AND f.id = $2 AND i.expires_at > NOW()`,
      [slug, fileId]
    );
    return rows[0] || null;
  }


  router.get('/api/items/:slug/download-zip', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, title, expires_at
         FROM items WHERE slug = $1 AND expires_at > NOW()`,
        [req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const item = rows[0];
      const files = await pool.query(
        `SELECT relative_path, size_bytes, mime, storage_name
         FROM item_files WHERE item_id = $1 ORDER BY relative_path`,
        [item.id]
      );
      if (!files.rows.length) return res.status(404).json({ error: 'No files' });

      const safeTitle = String(item.title || 'download')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .trim()
        .slice(0, 80) || 'download';

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle + '.zip')}`
      );
      res.setHeader('Cache-Control', 'no-store');

      // STORE only — no compression (CPU-cheap single-file download)
      const archive = archiver('zip', { store: true, zlib: { level: 0 } });
      archive.on('error', (err) => {
        console.error('zip archive', err);
        if (!res.headersSent) res.status(500).json({ error: 'Zip error' });
        else res.end();
      });
      req.on('close', () => {
        try {
          archive.abort();
        } catch (_) {}
      });
      archive.pipe(res);

      for (const f of files.rows) {
        const full = storagePathFor(item.id, f.storage_name);
        const entryName = String(f.relative_path || path.posix.basename(f.storage_name)).replace(
          /^\/+/,
          ''
        );
        archive.file(full, { name: entryName, store: true });
      }
      await archive.finalize();
    } catch (err) {
      console.error('download-zip', err);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/items/:slug/files/:fileId/download', requireAuth, async (req, res) => {
    try {
      const file = await resolveFile(req.params.slug, req.params.fileId);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const full = storagePathFor(file.item_id, file.storage_name);
      res.setHeader('Content-Type', file.mime || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(file.relative_path))}`
      );
      if (file.size_bytes) res.setHeader('Content-Length', String(file.size_bytes));
      fs.createReadStream(full).on('error', () => {
        if (!res.headersSent) res.status(404).end();
        else res.end();
      }).pipe(res);
    } catch (err) {
      console.error('download', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/items/:slug/files/:fileId/preview', requireAuth, async (req, res) => {
    try {
      const file = await resolveFile(req.params.slug, req.params.fileId);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const m = file.mime || 'application/octet-stream';
      if (!isPreviewableMime(m)) {
        return res.status(415).json({ error: 'Not previewable' });
      }
      const full = storagePathFor(file.item_id, file.storage_name);
      res.setHeader('Cache-Control', 'private, max-age=300');

      if (m.startsWith('image/') && req.query.w) {
        const w = Math.min(2000, Math.max(16, parseInt(String(req.query.w), 10) || 0));
        if (w) {
          try {
            const sharp = require('sharp');
            res.setHeader('Content-Type', 'image/jpeg');
            const stream = sharp(full).rotate().resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 82 });
            stream.on('error', () => {
              if (!res.headersSent) res.status(500).end();
            });
            return stream.pipe(res);
          } catch (err) {
            console.error('sharp', err.message);
            // fall through to original
          }
        }
      }

      if (m.startsWith('text/') || m === 'application/json' || m === 'application/javascript' || m === 'application/xml') {
        const fh = await fsp.open(full, 'r');
        try {
          const buf = Buffer.alloc(100 * 1024);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.send(buf.subarray(0, bytesRead).toString('utf8'));
        } finally {
          await fh.close();
        }
        return;
      }

      res.setHeader('Content-Type', m);
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(path.posix.basename(file.relative_path))}`
      );
      fs.createReadStream(full).on('error', () => {
        if (!res.headersSent) res.status(404).end();
        else res.end();
      }).pipe(res);
    } catch (err) {
      console.error('preview', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Static frontend
  const publicDir = path.join(__dirname, 'dist');
  router.use(express.static(publicDir, { index: false, maxAge: '1h' }));
  router.get(['/', '/*'], (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  if (BASE_PATH) {
    app.use(BASE_PATH, router);
    app.get(BASE_PATH.replace(/\/$/, ''), (req, res) => {
      res.redirect(301, `${BASE_PATH}/`);
    });
  } else {
    app.use(router);
  }

  app.use((err, req, res, _next) => {
    console.error('unhandled', err);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  });

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`file-transfer listening on 127.0.0.1:${PORT} base=${BASE_PATH || '/'}`);
  });
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { nanoid } = require('nanoid');
const mime = require('mime-types');
const {
  sanitizeRelativePath,
  fixUtf8Filename,
  storagePathFor,
  itemDir,
  uploadDir,
  uploadChunkPath,
  uploadsRoot,
} = require('./paths');
const { deleteUploadFiles } = require('./cleanup');

const DEFAULT_CHUNK_SIZE = (() => {
  const configured = Number(process.env.CHUNK_SIZE);
  return Number.isFinite(configured) && configured > 0 ? configured : 8 * 1024 * 1024;
})(); // 8 MiB
const MAX_FILES_PER_UPLOAD = 50000;

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

function chunkCountFor(sizeBytes, chunkSize) {
  if (sizeBytes <= 0) return 1;
  return Math.ceil(sizeBytes / chunkSize);
}

function expectedChunkSize(fileSize, chunkSize, chunkIndex, chunkCount) {
  if (fileSize <= 0) return 0;
  if (chunkIndex < chunkCount - 1) return chunkSize;
  return fileSize - chunkSize * (chunkCount - 1);
}

function drainRequest(req) {
  return new Promise((resolve) => {
    req.resume();
    if (req.complete) return resolve();
    req.on('end', resolve);
    req.on('close', resolve);
  });
}

async function streamToFile(req, destPath, expectSize) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  if (expectSize === 0) {
    await drainRequest(req);
    await fsp.writeFile(destPath, Buffer.alloc(0));
    return 0;
  }

  const tmp = `${destPath}.tmp-${randomUUID()}`;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let aborted = false;

  return new Promise((resolve, reject) => {
    const fail = async (err) => {
      if (aborted) return;
      aborted = true;
      try {
        req.unpipe(out);
      } catch (_) {}
      out.destroy();
      try {
        await fsp.rm(tmp, { force: true });
      } catch (_) {}
      reject(err);
    };

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > expectSize) {
        fail(Object.assign(new Error('Chunk too large'), { status: 413 }));
      }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', async () => {
      if (aborted) return;
      try {
        await fsp.rename(tmp, destPath);
        resolve(received);
      } catch (err) {
        fail(err);
      }
    });
    req.pipe(out);
  });
}

async function assembleFile(uploadId, fileIndex, chunkCount, outPath) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    (async () => {
      try {
        for (let i = 0; i < chunkCount; i++) {
          const buf = await fsp.readFile(uploadChunkPath(uploadId, fileIndex, i));
          const ok = out.write(buf);
          if (!ok) {
            await new Promise((r) => out.once('drain', r));
          }
        }
        out.end();
        out.on('finish', resolve);
      } catch (err) {
        out.destroy();
        reject(err);
      }
    })();
  });
}

function registerUploadRoutes(router, opts) {
  const {
    pool,
    requireAuth,
    RETENTION,
    MAX_UPLOAD_BYTES,
    BASE_PATH,
    publicItemUrl,
    DEFAULT_CHUNK_SIZE: configuredChunkSize,
  } = opts;
  const defaultChunkSize = configuredChunkSize || DEFAULT_CHUNK_SIZE;

  fsp.mkdir(uploadsRoot(), { recursive: true }).catch(() => {});

  router.post('/api/uploads', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const retention = String(body.retention || '24h');
      if (!RETENTION[retention]) {
        return res.status(400).json({ error: 'Invalid retention' });
      }
      let title = typeof body.title === 'string' ? fixUtf8Filename(body.title).trim().slice(0, 200) : '';
      const filesIn = Array.isArray(body.files) ? body.files : null;
      if (!filesIn || !filesIn.length) {
        return res.status(400).json({ error: 'files required' });
      }
      if (filesIn.length > MAX_FILES_PER_UPLOAD) {
        return res.status(400).json({ error: 'Too many files' });
      }

      const chunkSize = Math.min(
        16 * 1024 * 1024,
        Math.max(1 * 1024 * 1024, Number(body.chunk_size) || defaultChunkSize)
      );

      const prepared = [];
      let totalBytes = 0;
      const seenPaths = new Set();

      for (let i = 0; i < filesIn.length; i++) {
        const f = filesIn[i] || {};
        const relative = sanitizeRelativePath(f.relative_path || f.name);
        if (!relative) {
          return res.status(400).json({ error: `Invalid file path at index ${i}` });
        }
        if (seenPaths.has(relative)) {
          return res.status(400).json({ error: `Duplicate path: ${relative}` });
        }
        seenPaths.add(relative);
        const sizeBytes = Number(f.size_bytes);
        if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || !Number.isInteger(sizeBytes)) {
          return res.status(400).json({ error: `Invalid size for ${relative}` });
        }
        totalBytes += sizeBytes;
        if (totalBytes > MAX_UPLOAD_BYTES) {
          return res.status(413).json({ error: 'Upload exceeds 20 GB limit' });
        }
        const mimeType =
          (typeof f.mime === 'string' && f.mime.slice(0, 200)) ||
          mime.lookup(relative) ||
          'application/octet-stream';
        const storageName = `${randomUUID()}${path.extname(relative).slice(0, 64)}`;
        const chunkCount = chunkCountFor(sizeBytes, chunkSize);
        prepared.push({
          file_index: i,
          relative_path: relative,
          size_bytes: sizeBytes,
          mime: mimeType,
          storage_name: storageName,
          chunk_count: chunkCount,
        });
      }

      if (!title) {
        const first = prepared[0].relative_path;
        if (prepared.length === 1) {
          title = path.posix.basename(first);
        } else {
          const root = first.split('/')[0];
          const sameRoot = prepared.every((f) => f.relative_path.split('/')[0] === root);
          title = sameRoot && first.includes('/') ? root : `Upload (${prepared.length} files)`;
        }
      }

      const uploadId = randomUUID();
      await fsp.mkdir(uploadDir(uploadId), { recursive: true });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO uploads (id, title, retention, status, chunk_size, total_bytes)
           VALUES ($1,$2,$3,'pending',$4,$5)`,
          [uploadId, title, retention, chunkSize, totalBytes]
        );
        for (const f of prepared) {
          await client.query(
            `INSERT INTO upload_files
               (id, upload_id, file_index, relative_path, size_bytes, mime, storage_name, chunk_count)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              randomUUID(),
              uploadId,
              f.file_index,
              f.relative_path,
              f.size_bytes,
              f.mime,
              f.storage_name,
              f.chunk_count,
            ]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        await deleteUploadFiles(uploadId).catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      res.status(201).json({
        uploadId,
        chunkSize,
        totalBytes,
        title,
        files: prepared.map((f) => ({
          fileIndex: f.file_index,
          relative_path: f.relative_path,
          size_bytes: f.size_bytes,
          chunk_count: f.chunk_count,
        })),
      });
    } catch (err) {
      console.error('create upload', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.put(
    '/api/uploads/:uploadId/files/:fileIndex/chunks/:chunkIndex',
    requireAuth,
    async (req, res) => {
      const uploadId = req.params.uploadId;
      const fileIndex = parseInt(req.params.fileIndex, 10);
      const chunkIndex = parseInt(req.params.chunkIndex, 10);
      if (
        !/^[0-9a-f-]{36}$/i.test(uploadId) ||
        !Number.isInteger(fileIndex) ||
        fileIndex < 0 ||
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0
      ) {
        return res.status(400).json({ error: 'Invalid params' });
      }

      try {
        const { rows: upRows } = await pool.query(
          `SELECT id, status, chunk_size FROM uploads WHERE id = $1`,
          [uploadId]
        );
        if (!upRows.length) return res.status(404).json({ error: 'Upload not found' });
        const upload = upRows[0];
        if (upload.status !== 'pending') {
          await drainRequest(req);
          return res.status(409).json({ error: 'Upload not accepting chunks' });
        }

        const { rows: fRows } = await pool.query(
          `SELECT file_index, size_bytes, chunk_count FROM upload_files
           WHERE upload_id = $1 AND file_index = $2`,
          [uploadId, fileIndex]
        );
        if (!fRows.length) {
          await drainRequest(req);
          return res.status(404).json({ error: 'File not found' });
        }
        const file = fRows[0];
        if (chunkIndex >= file.chunk_count) {
          await drainRequest(req);
          return res.status(400).json({ error: 'Chunk index out of range' });
        }

        const expectSize = expectedChunkSize(
          Number(file.size_bytes),
          upload.chunk_size,
          chunkIndex,
          file.chunk_count
        );

        const { rows: existing } = await pool.query(
          `SELECT size_bytes FROM upload_chunks
           WHERE upload_id = $1 AND file_index = $2 AND chunk_index = $3`,
          [uploadId, fileIndex, chunkIndex]
        );
        if (existing.length) {
          await drainRequest(req);
          if (Number(existing[0].size_bytes) === expectSize) {
            return res.json({ ok: true, duplicate: true });
          }
          return res.status(409).json({ error: 'Chunk size mismatch' });
        }

        const dest = uploadChunkPath(uploadId, fileIndex, chunkIndex);
        let received;
        try {
          received = await streamToFile(req, dest, expectSize);
        } catch (err) {
          if (err.status === 413) {
            return res.status(413).json({ error: 'Chunk too large' });
          }
          throw err;
        }

        if (received !== expectSize) {
          await fsp.rm(dest, { force: true }).catch(() => {});
          return res.status(400).json({
            error: `Expected ${expectSize} bytes, got ${received}`,
          });
        }

        await pool.query(
          `INSERT INTO upload_chunks (upload_id, file_index, chunk_index, size_bytes)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          [uploadId, fileIndex, chunkIndex, received]
        );
        await pool.query(`UPDATE uploads SET updated_at = NOW() WHERE id = $1`, [uploadId]);

        res.json({ ok: true, size: received });
      } catch (err) {
        console.error('chunk put', err);
        if (!res.headersSent) res.status(500).json({ error: 'Server error' });
      }
    }
  );

  router.post('/api/uploads/:uploadId/complete', requireAuth, async (req, res) => {
    const uploadId = req.params.uploadId;
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
      return res.status(400).json({ error: 'Invalid upload id' });
    }

    let itemId = null;
    let upload;
    let files;

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: upRows } = await client.query(
          `SELECT id, title, retention, status, chunk_size, total_bytes
           FROM uploads WHERE id = $1 FOR UPDATE`,
          [uploadId]
        );
        if (!upRows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Upload not found' });
        }
        upload = upRows[0];
        if (upload.status === 'completed') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Already completed' });
        }
        if (upload.status === 'aborted') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Upload aborted' });
        }
        if (upload.status !== 'pending') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Upload busy' });
        }

        await client.query(
          `UPDATE uploads SET status = 'completing', updated_at = NOW() WHERE id = $1`,
          [uploadId]
        );

        const fileRes = await client.query(
          `SELECT file_index, relative_path, size_bytes, mime, storage_name, chunk_count
           FROM upload_files WHERE upload_id = $1 ORDER BY file_index`,
          [uploadId]
        );
        files = fileRes.rows;

        for (const f of files) {
          const { rows: chunks } = await client.query(
            `SELECT chunk_index, size_bytes FROM upload_chunks
             WHERE upload_id = $1 AND file_index = $2 ORDER BY chunk_index`,
            [uploadId, f.file_index]
          );
          if (chunks.length !== f.chunk_count) {
            await client.query(
              `UPDATE uploads SET status = 'pending', updated_at = NOW() WHERE id = $1`,
              [uploadId]
            );
            await client.query('COMMIT');
            return res.status(400).json({
              error: `Missing chunks for ${f.relative_path}: ${chunks.length}/${f.chunk_count}`,
            });
          }
          for (let i = 0; i < f.chunk_count; i++) {
            const expect = expectedChunkSize(
              Number(f.size_bytes),
              upload.chunk_size,
              i,
              f.chunk_count
            );
            if (
              !chunks[i] ||
              chunks[i].chunk_index !== i ||
              Number(chunks[i].size_bytes) !== expect
            ) {
              await client.query(
                `UPDATE uploads SET status = 'pending', updated_at = NOW() WHERE id = $1`,
                [uploadId]
              );
              await client.query('COMMIT');
              return res.status(400).json({ error: `Bad chunk ${i} for ${f.relative_path}` });
            }
          }
        }

        if (!RETENTION[upload.retention]) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Invalid retention' });
        }

        itemId = randomUUID();
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {}
        throw err;
      } finally {
        client.release();
      }

      await fsp.mkdir(itemDir(itemId), { recursive: true });

      for (const f of files) {
        const outPath = storagePathFor(itemId, f.storage_name);
        await assembleFile(uploadId, f.file_index, f.chunk_count, outPath);
        const st = await fsp.stat(outPath);
        if (st.size !== Number(f.size_bytes)) {
          throw new Error(`Assembled size mismatch for ${f.relative_path}`);
        }
      }

      const kind =
        files.length === 1 && !files[0].relative_path.includes('/') ? 'file' : 'folder';
      const expiresAt = new Date(Date.now() + RETENTION[upload.retention]);
      let slug = nanoid(10);
      const totalBytes = Number(upload.total_bytes);

      const c2 = await pool.connect();
      try {
        await c2.query('BEGIN');
        const { rows: live } = await c2.query(
          `SELECT status FROM uploads WHERE id = $1 FOR UPDATE`,
          [uploadId]
        );
        if (!live.length || live[0].status !== 'completing') {
          await c2.query('ROLLBACK');
          throw Object.assign(new Error('Upload aborted during finalize'), { status: 409 });
        }
        for (let i = 0; i < 5; i++) {
          try {
            await c2.query(
              `INSERT INTO items (id, slug, title, kind, expires_at, size_bytes, mime, original_name)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                itemId,
                slug,
                upload.title,
                kind,
                expiresAt,
                totalBytes,
                kind === 'file' ? files[0].mime : null,
                kind === 'file' ? files[0].relative_path : null,
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
        for (const f of files) {
          await c2.query(
            `INSERT INTO item_files (id, item_id, relative_path, size_bytes, mime, storage_name)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [randomUUID(), itemId, f.relative_path, f.size_bytes, f.mime, f.storage_name]
          );
        }
        await c2.query(
          `UPDATE uploads SET status = 'completed', updated_at = NOW() WHERE id = $1`,
          [uploadId]
        );
        await c2.query('COMMIT');
      } catch (err) {
        await c2.query('ROLLBACK');
        throw err;
      } finally {
        c2.release();
      }

      await deleteUploadFiles(uploadId).catch(() => {});

      return res.status(201).json({
        item: {
          id: itemId,
          slug,
          title: upload.title,
          kind,
          expires_at: expiresAt.toISOString(),
          size_bytes: totalBytes,
          size_label: formatBytes(totalBytes),
          url: publicItemUrl(slug, req),
          path_url: `${BASE_PATH}/?id=${encodeURIComponent(slug)}`,
        },
      });
    } catch (err) {
      console.error('complete upload', err);
      if (itemId) {
        await fsp.rm(itemDir(itemId), { recursive: true, force: true }).catch(() => {});
      }
      if (err && err.status === 409) {
        await deleteUploadFiles(uploadId).catch(() => {});
        if (!res.headersSent) return res.status(409).json({ error: 'Upload aborted' });
        return;
      }
      await pool
        .query(
          `UPDATE uploads SET status = 'pending', updated_at = NOW()
           WHERE id = $1 AND status = 'completing'`,
          [uploadId]
        )
        .catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: 'Failed to finalize upload' });
    }
  });

  router.delete('/api/uploads/:uploadId', requireAuth, async (req, res) => {
    const uploadId = req.params.uploadId;
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
      return res.status(400).json({ error: 'Invalid upload id' });
    }
    try {
      const { rows } = await pool.query(`SELECT status FROM uploads WHERE id = $1`, [uploadId]);
      if (!rows.length) {
        await deleteUploadFiles(uploadId).catch(() => {});
        return res.json({ ok: true });
      }
      if (rows[0].status === 'completed') {
        return res.status(409).json({ error: 'Already completed' });
      }
      await pool.query(`DELETE FROM uploads WHERE id = $1`, [uploadId]);
      await deleteUploadFiles(uploadId).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      console.error('abort upload', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/uploads/:uploadId', requireAuth, async (req, res) => {
    try {
      const uploadId = req.params.uploadId;
      if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
        return res.status(400).json({ error: 'Invalid upload id' });
      }
      const { rows } = await pool.query(
        `SELECT id, title, retention, status, chunk_size, total_bytes, created_at, updated_at
         FROM uploads WHERE id = $1`,
        [uploadId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const upload = rows[0];
      const { rows: files } = await pool.query(
        `SELECT file_index, relative_path, size_bytes, chunk_count
         FROM upload_files WHERE upload_id = $1 ORDER BY file_index`,
        [uploadId]
      );
      const { rows: chunkRows } = await pool.query(
        `SELECT file_index, chunk_index, size_bytes
         FROM upload_chunks WHERE upload_id = $1
         ORDER BY file_index, chunk_index`,
        [uploadId]
      );
      const byFile = new Map();
      for (const f of files) {
        byFile.set(f.file_index, {
          file_index: f.file_index,
          relative_path: f.relative_path,
          size_bytes: Number(f.size_bytes),
          chunk_count: f.chunk_count,
          received_chunks: 0,
          received_chunk_indices: [],
          received_bytes: 0,
        });
      }
      let receivedBytes = 0;
      for (const c of chunkRows) {
        const entry = byFile.get(c.file_index);
        if (!entry) continue;
        entry.received_chunk_indices.push(c.chunk_index);
        entry.received_chunks += 1;
        const sz = Number(c.size_bytes) || 0;
        entry.received_bytes += sz;
        receivedBytes += sz;
      }
      const fileList = files.map((f) => byFile.get(f.file_index));
      res.json({
        upload,
        files: fileList,
        receivedBytes,
        totalBytes: Number(upload.total_bytes) || 0,
      });
    } catch (err) {
      console.error('get upload', err);
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = {
  registerUploadRoutes,
  DEFAULT_CHUNK_SIZE,
};

'use strict';

const fs = require('fs/promises');
const path = require('path');
const { getPool } = require('./db');
const { uploadDir, uploadsRoot } = require('./paths');

async function deleteItemFiles(itemId) {
  const storageDir = process.env.STORAGE_DIR;
  const dir = path.join(storageDir, itemId);
  await fs.rm(dir, { recursive: true, force: true });
}

async function deleteUploadFiles(uploadId) {
  await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
}

async function purgeExpired() {
  const p = getPool();
  const { rows } = await p.query(
    `DELETE FROM items WHERE expires_at < NOW() RETURNING id`
  );
  for (const row of rows) {
    try {
      await deleteItemFiles(row.id);
    } catch (err) {
      console.error('[cleanup] failed to remove files for', row.id, err.message);
    }
  }
  if (rows.length) {
    console.log(`[cleanup] purged ${rows.length} expired item(s)`);
  }
  return rows.length;
}

async function purgeAbandonedUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
  const p = getPool();
  const cutoff = new Date(Date.now() - maxAgeMs);
  const { rows } = await p.query(
    `DELETE FROM uploads
     WHERE status IN ('pending', 'aborted')
       AND updated_at < $1
     RETURNING id`,
    [cutoff]
  );
  for (const row of rows) {
    try {
      await deleteUploadFiles(row.id);
    } catch (err) {
      console.error('[cleanup] failed to remove upload', row.id, err.message);
    }
  }
  // Orphan temp dirs without DB rows (best-effort)
  try {
    const root = uploadsRoot();
    const entries = await fs.readdir(root).catch(() => []);
    for (const name of entries) {
      const { rows: live } = await p.query(`SELECT 1 FROM uploads WHERE id = $1`, [name]);
      if (!live.length) {
        await fs.rm(path.join(root, name), { recursive: true, force: true });
      }
    }
  } catch (err) {
    console.error('[cleanup] upload orphans', err.message);
  }
  if (rows.length) {
    console.log(`[cleanup] purged ${rows.length} abandoned upload(s)`);
  }
  return rows.length;
}

function startCleanupJob(intervalMs = 3 * 60 * 1000, abandonedUploadTtlMs = 24 * 60 * 60 * 1000) {
  const run = async () => {
    await purgeExpired();
    await purgeAbandonedUploads(abandonedUploadTtlMs);
  };
  run().catch((err) => console.error('[cleanup] initial', err));
  const timer = setInterval(() => {
    run().catch((err) => console.error('[cleanup]', err));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  purgeExpired,
  purgeAbandonedUploads,
  deleteItemFiles,
  deleteUploadFiles,
  startCleanupJob,
};

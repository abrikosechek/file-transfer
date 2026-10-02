'use strict';

const path = require('path');

/**
 * Fix UTF-8 filenames that were decoded as Latin-1 (classic mojibake).
 * Busboy/multipart Content-Disposition filename="…" often yields a JS string
 * whose code units are the raw UTF-8 bytes (e.g. "И" → U+00D0,U+0098).
 * Already-correct Unicode (codepoints > 0xFF) is left untouched.
 */
function fixUtf8Filename(raw) {
  if (raw == null) return raw;
  const s = String(raw);
  if (!s) return s;
  // Proper Unicode already (Cyrillic etc. live above U+00FF)
  if (/[^\u0000-\u00ff]/.test(s)) return s;
  // Pure ASCII — nothing to fix
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  const decoded = Buffer.from(s, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD')) return s;
  return decoded;
}

/**
 * Normalize and validate a relative upload path (posix).
 * Rejects absolute paths, drive letters, and .. segments.
 */
function sanitizeRelativePath(raw) {
  if (raw == null) return null;
  let s = fixUtf8Filename(String(raw)).replace(/\\/g, '/');
  // strip leading ./ and /
  s = s.replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!s || s.includes('\0')) return null;
  const parts = s.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  if (parts.some((p) => p === '' || p.includes('\0'))) return null;
  // reject weird absolute-like Windows paths
  if (/^[a-zA-Z]:/.test(parts[0] || '')) return null;
  const joined = parts.join('/');
  if (joined.length > 1024) return null;
  return joined;
}

function storagePathFor(itemId, storageName) {
  return path.join(process.env.STORAGE_DIR, itemId, storageName);
}

function itemDir(itemId) {
  return path.join(process.env.STORAGE_DIR, itemId);
}

function uploadsRoot() {
  return path.join(process.env.STORAGE_DIR, '.uploads');
}

function uploadDir(uploadId) {
  return path.join(uploadsRoot(), uploadId);
}

function uploadChunkPath(uploadId, fileIndex, chunkIndex) {
  return path.join(uploadDir(uploadId), String(fileIndex), `${chunkIndex}.chunk`);
}

function uploadFileDir(uploadId, fileIndex) {
  return path.join(uploadDir(uploadId), String(fileIndex));
}

module.exports = {
  fixUtf8Filename,
  sanitizeRelativePath,
  storagePathFor,
  itemDir,
  uploadsRoot,
  uploadDir,
  uploadChunkPath,
  uploadFileDir,
};

/** App base path under the site (no trailing slash). */
export const BASE_PATH = (() => {
  const p = typeof location !== 'undefined' ? location.pathname : '/file-transfer';
  if (p === '/file-transfer' || p.startsWith('/file-transfer/')) return '/file-transfer';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
})();

function positiveEnvNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const CHUNK_SIZE = positiveEnvNumber(import.meta.env.VITE_CHUNK_SIZE, 8 * 1024 * 1024);
export const UPLOAD_CONCURRENCY = positiveEnvNumber(import.meta.env.VITE_UPLOAD_CONCURRENCY, 4);
export const MAX_UPLOAD_BYTES = positiveEnvNumber(
  import.meta.env.VITE_MAX_UPLOAD_BYTES,
  20 * 1024 * 1024 * 1024
);
export const DOWNLOAD_CONCURRENCY = 3;

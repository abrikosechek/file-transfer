import {
  pathBasename,
  sanitizeDirectoryName,
  sleep,
  splitRelPath,
} from '@/shared/lib/format';
import { DOWNLOAD_CONCURRENCY } from '@/shared/config';
import { fileDownloadUrl, itemZipDownloadUrl } from './api';
import type { TransferFile, TransferItem } from './types';

export type DownloadProgress = {
  done: number;
  total: number;
  currentName?: string;
  failed: number;
  phase: 'picking' | 'downloading' | 'done';
};

export type DownloadAllResult = {
  count: number;
  failed: number;
  errors: Array<{ path: string; error: string }>;
  usedFallback: boolean;
  usedZip?: boolean;
  fallbackHint?: string;
};

async function ensureSubdir(
  rootHandle: FileSystemDirectoryHandle,
  dirs: string[]
): Promise<FileSystemDirectoryHandle> {
  let dir = rootHandle;
  for (const part of dirs) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

async function fetchWithRetry(
  url: string,
  attempts = 3
): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Download failed');
}

async function saveViaDirectoryPicker(
  item: TransferItem,
  files: TransferFile[],
  onProgress: (p: DownloadProgress) => void
): Promise<DownloadAllResult> {
  if (!window.showDirectoryPicker) throw new TypeError('NotSupportedError');
  onProgress({ done: 0, total: files.length, phase: 'picking', failed: 0 });
  const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const itemDirHandle = await dirHandle.getDirectoryHandle(sanitizeDirectoryName(item.title), {
    create: true,
  });

  let next = 0;
  let done = 0;
  let failed = 0;
  const errors: Array<{ path: string; error: string }> = [];
  const total = files.length;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= files.length) return;
      const f = files[i];
      onProgress({
        done,
        total,
        currentName: f.relative_path,
        failed,
        phase: 'downloading',
      });
      try {
        const url = fileDownloadUrl(item.slug, f.id);
        const res = await fetchWithRetry(url);
        const { dirs, fileName } = splitRelPath(f.relative_path);
        const dir = await ensureSubdir(itemDirHandle, dirs);
        const fh = await dir.getFileHandle(fileName, { create: true });
        const writable = await fh.createWritable();
        await res.body!.pipeTo(writable);
        done++;
      } catch (err) {
        failed++;
        errors.push({
          path: f.relative_path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      onProgress({
        done,
        total,
        currentName: f.relative_path,
        failed,
        phase: 'downloading',
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, files.length) }, () => worker())
  );

  onProgress({ done, total, failed, phase: 'done' });
  return { count: done, failed, errors, usedFallback: false };
}

async function saveViaSequentialAnchors(
  item: TransferItem,
  files: TransferFile[],
  onProgress: (p: DownloadProgress) => void
): Promise<DownloadAllResult> {
  const total = files.length;
  const sanitizedTitle = sanitizeDirectoryName(item.title);
  let done = 0;
  let failed = 0;
  const errors: Array<{ path: string; error: string }> = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress({
      done,
      total,
      currentName: f.relative_path,
      failed,
      phase: 'downloading',
    });
    try {
      const url = fileDownloadUrl(item.slug, f.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizedTitle} - ${pathBasename(f.relative_path)}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      done++;
    } catch (err) {
      failed++;
      errors.push({
        path: f.relative_path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    onProgress({
      done,
      total,
      currentName: f.relative_path,
      failed,
      phase: 'downloading',
    });
    if (i < files.length - 1) await sleep(450);
  }

  onProgress({ done, total, failed, phase: 'done' });
  return {
    count: done,
    failed,
    errors,
    usedFallback: true,
    fallbackHint: `Браузер не дал выбрать папку — файлы уходят в «Загрузки» с префиксом «${sanitizedTitle} - ». В Chrome/Edge можно повторить и выбрать папку.`,
  };
}

/**
 * Batch download into a real folder tree when File System Access is available.
 * On failure of individual files: retry, collect errors, do not abort the whole batch.
 */
export async function downloadAllContents(
  item: TransferItem,
  files: TransferFile[],
  onProgress: (p: DownloadProgress) => void
): Promise<DownloadAllResult> {
  if (!files.length) {
    return { count: 0, failed: 0, errors: [], usedFallback: false };
  }

  onProgress({ done: 0, total: files.length, failed: 0, phase: 'picking' });

  if (typeof window.showDirectoryPicker === 'function') {
    try {
      return await saveViaDirectoryPicker(item, files, onProgress);
    } catch (e) {
      const err = e as { name?: string };
      if (err?.name === 'AbortError') throw e;
      const name = err?.name || '';
      if (
        name === 'SecurityError' ||
        name === 'NotAllowedError' ||
        name === 'TypeError' ||
        name === 'NotSupportedError'
      ) {
        console.warn('directory picker unavailable, falling back', e);
      } else {
        // Unexpected mid-batch hard failure — still try fallback only if nothing saved?
        throw e;
      }
    }
  }

  return saveViaSequentialAnchors(item, files, onProgress);
}

/** Single-file STORE (no compress) zip from server — good for Firefox / one-click. */
export function downloadAsStoreZip(item: TransferItem): void {
  const a = document.createElement('a');
  a.href = itemZipDownloadUrl(item.slug);
  a.download = `${sanitizeDirectoryName(item.title)}.zip`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function supportsDirectoryPicker(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

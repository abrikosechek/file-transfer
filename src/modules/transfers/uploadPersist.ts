import type { Retention } from './types';

const STORAGE_KEY = 'file-transfer:pending-upload:v1';

export type PersistedFileMeta = {
  relativePath: string;
  size: number;
  lastModified: number;
  name: string;
};

export type PersistedUpload = {
  uploadId: string;
  title: string;
  retention: Retention;
  chunkSize: number;
  totalBytes: number;
  createdAt: number;
  files: PersistedFileMeta[];
  /** Keys `${fileIndex}:${chunkIndex}` that client believes are done (server is source of truth). */
  completedChunkKeys: string[];
};

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function loadPersistedUpload(): PersistedUpload | null {
  if (!canUseStorage()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedUpload;
    if (!data?.uploadId || !Array.isArray(data.files) || !data.files.length) return null;
    return {
      ...data,
      completedChunkKeys: Array.isArray(data.completedChunkKeys) ? data.completedChunkKeys : [],
    };
  } catch {
    return null;
  }
}

export function savePersistedUpload(state: PersistedUpload): void {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
}

export function clearPersistedUpload(uploadId?: string): void {
  if (!canUseStorage()) return;
  try {
    if (uploadId) {
      const cur = loadPersistedUpload();
      if (cur && cur.uploadId !== uploadId) return;
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function chunkKey(fileIndex: number, chunkIndex: number): string {
  return `${fileIndex}:${chunkIndex}`;
}

export function markChunkCompleted(uploadId: string, fileIndex: number, chunkIndex: number): void {
  const cur = loadPersistedUpload();
  if (!cur || cur.uploadId !== uploadId) return;
  const key = chunkKey(fileIndex, chunkIndex);
  if (cur.completedChunkKeys.includes(key)) return;
  cur.completedChunkKeys = [...cur.completedChunkKeys, key];
  savePersistedUpload(cur);
}

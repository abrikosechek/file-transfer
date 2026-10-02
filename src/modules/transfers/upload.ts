import { api, apiJson, ApiError } from '@/shared/lib/apiClient';
import { BASE_PATH, CHUNK_SIZE, MAX_UPLOAD_BYTES, UPLOAD_CONCURRENCY } from '@/shared/config';
import type { Retention, SelectedFile, TransferItem } from './types';
import {
  clearPersistedUpload,
  chunkKey,
  loadPersistedUpload,
  markChunkCompleted,
  savePersistedUpload,
  type PersistedUpload,
} from './uploadPersist';
import { getUploadStatus, type UploadStatusResponse } from './api';

export type UploadProgress = {
  loaded: number;
  total: number;
  phase: 'uploading' | 'finalizing' | 'cancelling';
};

export type UploadController = {
  cancel: () => Promise<void>;
  promise: Promise<{ item: TransferItem }>;
};

export type { PersistedUpload };
export { loadPersistedUpload, clearPersistedUpload };

async function runPool(tasks: Array<() => Promise<void>>, concurrency: number, cancelled: () => boolean) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (i < tasks.length) {
      if (cancelled()) return;
      const cur = i++;
      await tasks[cur]();
    }
  });
  await Promise.all(workers);
}

function fileMeta(selected: SelectedFile[]) {
  return selected.map(({ file, relativePath }) => ({
    relativePath,
    size: file.size,
    lastModified: file.lastModified,
    name: file.name,
  }));
}

/** Match selected files to persisted order by path + size + mtime. */
export function matchSelectedToPersisted(
  selected: SelectedFile[],
  persisted: PersistedUpload
): SelectedFile[] | null {
  if (selected.length !== persisted.files.length) return null;
  const pool = new Map<string, SelectedFile[]>();
  for (const s of selected) {
    const key = `${s.relativePath}|${s.file.size}|${s.file.lastModified}`;
    const list = pool.get(key) || [];
    list.push(s);
    pool.set(key, list);
  }
  const ordered: SelectedFile[] = [];
  for (const meta of persisted.files) {
    const key = `${meta.relativePath}|${meta.size}|${meta.lastModified}`;
    const list = pool.get(key);
    if (!list?.length) return null;
    ordered.push(list.shift()!);
  }
  return ordered;
}

export function summarizePersisted(p: PersistedUpload): string {
  const pctHint =
    p.totalBytes > 0 && p.completedChunkKeys.length
      ? ` · чанков отмечено: ${p.completedChunkKeys.length}`
      : '';
  return `«${p.title || 'без названия'}» · ${p.files.length} файл(ов), ${(p.totalBytes / (1024 * 1024)).toFixed(1)} МБ${pctHint}`;
}

function receivedSetFromStatus(status: UploadStatusResponse): {
  done: Set<string>;
  loadedBytes: number;
} {
  const done = new Set<string>();
  let loadedBytes = 0;
  for (const f of status.files) {
    const indices = f.received_chunk_indices || [];
    for (const ci of indices) {
      done.add(chunkKey(f.file_index, ci));
    }
    loadedBytes += Number(f.received_bytes) || 0;
  }
  return { done, loadedBytes };
}

export function startChunkedUpload(
  selectedFiles: SelectedFile[],
  opts: {
    title: string;
    retention: Retention;
    onProgress: (p: UploadProgress) => void;
    /** Resume existing server session instead of POST /uploads */
    resumeUploadId?: string;
  }
): UploadController {
  let cancelled = false;
  let uploadId: string | null = null;
  const abortControllers: AbortController[] = [];

  const cancel = async () => {
    cancelled = true;
    for (const c of abortControllers) {
      try {
        c.abort();
      } catch {
        /* ignore */
      }
    }
    abortControllers.length = 0;
    opts.onProgress({ loaded: 0, total: 0, phase: 'cancelling' });
    const id = uploadId;
    uploadId = null;
    clearPersistedUpload(id || undefined);
    if (id) {
      try {
        await api(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch {
        /* ignore */
      }
    }
  };

  const promise = (async () => {
    const totalBytes = selectedFiles.reduce((s, f) => s + f.file.size, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error('Превышен лимит 20 ГБ');
    }

    opts.onProgress({ loaded: 0, total: totalBytes, phase: 'uploading' });

    let chunkSize = CHUNK_SIZE;
    let alreadyDone = new Set<string>();
    let uploadedBytes = 0;

    if (opts.resumeUploadId) {
      let status: UploadStatusResponse;
      try {
        status = await getUploadStatus(opts.resumeUploadId);
      } catch (err) {
        clearPersistedUpload(opts.resumeUploadId);
        if (err instanceof ApiError && err.status === 404) {
          throw new Error('Сессия загрузки истекла или удалена. Начните заново.');
        }
        throw err;
      }
      if (status.upload.status !== 'pending') {
        clearPersistedUpload(opts.resumeUploadId);
        throw new Error(
          status.upload.status === 'completed'
            ? 'Эта загрузка уже завершена'
            : 'Сессия загрузки недоступна для продолжения'
        );
      }
      // Validate file list still matches
      if (status.files.length !== selectedFiles.length) {
        throw new Error('Список файлов не совпадает с сессией на сервере');
      }
      for (let i = 0; i < selectedFiles.length; i++) {
        const sf = selectedFiles[i];
        const remote = status.files[i];
        if (
          remote.relative_path !== sf.relativePath ||
          Number(remote.size_bytes) !== sf.file.size
        ) {
          throw new Error('Файлы не совпадают с незавершённой загрузкой (путь/размер). Выберите те же файлы.');
        }
      }
      uploadId = opts.resumeUploadId;
      chunkSize = status.upload.chunk_size || CHUNK_SIZE;
      const recv = receivedSetFromStatus(status);
      alreadyDone = recv.done;
      uploadedBytes = recv.loadedBytes;
      opts.onProgress({ loaded: uploadedBytes, total: totalBytes, phase: 'uploading' });

      const persisted = loadPersistedUpload();
      savePersistedUpload({
        uploadId,
        title: opts.title || status.upload.title || '',
        retention: opts.retention,
        chunkSize,
        totalBytes,
        createdAt: persisted?.createdAt || Date.now(),
        files: fileMeta(selectedFiles),
        completedChunkKeys: [...alreadyDone],
      });
    } else {
      const sessionData = await apiJson<{
        uploadId: string;
        chunkSize?: number;
        title?: string;
      }>('/uploads', {
        method: 'POST',
        body: JSON.stringify({
          title: opts.title,
          retention: opts.retention,
          chunk_size: CHUNK_SIZE,
          files: selectedFiles.map(({ file, relativePath }) => ({
            relative_path: relativePath,
            size_bytes: file.size,
            mime: file.type || undefined,
          })),
        }),
      });

      if (cancelled) {
        await api(`/uploads/${encodeURIComponent(sessionData.uploadId)}`, { method: 'DELETE' }).catch(
          () => {}
        );
        throw new DOMException('Aborted', 'AbortError');
      }

      uploadId = sessionData.uploadId;
      chunkSize = sessionData.chunkSize || CHUNK_SIZE;
      savePersistedUpload({
        uploadId,
        title: opts.title || sessionData.title || '',
        retention: opts.retention,
        chunkSize,
        totalBytes,
        createdAt: Date.now(),
        files: fileMeta(selectedFiles),
        completedChunkKeys: [],
      });
    }

    if (cancelled) throw new DOMException('Aborted', 'AbortError');

    const tasks: Array<() => Promise<void>> = [];
    for (let fileIndex = 0; fileIndex < selectedFiles.length; fileIndex++) {
      const { file } = selectedFiles[fileIndex];
      const chunkCount = file.size <= 0 ? 1 : Math.ceil(file.size / chunkSize);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        if (alreadyDone.has(chunkKey(fileIndex, chunkIndex))) continue;
        const start = chunkIndex * chunkSize;
        const end = file.size <= 0 ? 0 : Math.min(file.size, start + chunkSize);
        tasks.push(async () => {
          if (cancelled) return;
          const blob = file.size <= 0 ? new Blob([]) : file.slice(start, end);
          const ac = new AbortController();
          abortControllers.push(ac);
          const url = `${BASE_PATH}/api/uploads/${encodeURIComponent(uploadId!)}/files/${fileIndex}/chunks/${chunkIndex}`;
          let lastErr: unknown = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (cancelled) return;
            try {
              const res = await fetch(url, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: blob,
                signal: ac.signal,
              });
              if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(data.error || `Chunk error ${res.status}`);
              }
              uploadedBytes += blob.size;
              markChunkCompleted(uploadId!, fileIndex, chunkIndex);
              opts.onProgress({ loaded: uploadedBytes, total: totalBytes, phase: 'uploading' });
              return;
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') return;
              lastErr = err;
              await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
            }
          }
          throw lastErr instanceof Error ? lastErr : new Error('Chunk upload failed');
        });
      }
    }

    await runPool(tasks, UPLOAD_CONCURRENCY, () => cancelled);
    if (cancelled) throw new DOMException('Aborted', 'AbortError');

    opts.onProgress({ loaded: totalBytes, total: totalBytes, phase: 'finalizing' });

    const doneData = await apiJson<{ item: TransferItem }>(
      `/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST', body: '{}' }
    );

    clearPersistedUpload(uploadId);
    uploadId = null;
    return { item: doneData.item };
  })().catch(async (err) => {
    if (cancelled) throw new DOMException('Aborted', 'AbortError');
    // Keep server session + localStorage for resume after network / tab reload.
    // Only clear uploadId pointer in-memory so cancel after error still works if user clicks cancel.
    throw err;
  });

  return { cancel, promise };
}

export function guessTitlePlaceholder(files: SelectedFile[]): string {
  if (!files.length) return '';
  const first = files[0].relativePath;
  if (files.length === 1) return first.split('/').pop() || first;
  const root = first.split('/')[0];
  const same = files.every((f) => f.relativePath.split('/')[0] === root);
  return same && first.includes('/') ? root : `Upload (${files.length} files)`;
}

export function filesFromFileList(fileList: FileList | File[], asFolder: boolean): SelectedFile[] {
  const arr = [...fileList];
  return arr.map((file) => {
    let relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (!asFolder) relativePath = file.name;
    relativePath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    return { file, relativePath };
  });
}

type FsEntry = FileSystemEntry & {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (
    successCallback: (file: File) => void,
    errorCallback?: (err: DOMException) => void
  ) => void;
  createReader: () => {
    readEntries: (
      successCallback: (entries: FsEntry[]) => void,
      errorCallback?: (err: DOMException) => void
    ) => void;
  };
};

export async function collectFromDataTransfer(dt: DataTransfer): Promise<SelectedFile[] | null> {
  const items = dt.items;
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    const collected: SelectedFile[] = [];
    const entries: FsEntry[] = [];
    for (const it of items) {
      const entry = it.webkitGetAsEntry?.() as FsEntry | null;
      if (entry) entries.push(entry);
    }

    async function walk(entry: FsEntry, prefix: string) {
      if (entry.isFile) {
        await new Promise<void>((resolve, reject) => {
          entry.file(
            (file) => {
              collected.push({
                file,
                relativePath: prefix ? `${prefix}/${file.name}` : file.name,
              });
              resolve();
            },
            reject
          );
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () =>
          new Promise<FsEntry[]>((resolve, reject) => {
            const all: FsEntry[] = [];
            const readBatch = () => {
              reader.readEntries((batch) => {
                if (!batch.length) return resolve(all);
                all.push(...batch);
                readBatch();
              }, reject);
            };
            readBatch();
          });
        const children = await readAll();
        const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        for (const child of children) {
          await walk(child, nextPrefix);
        }
      }
    }

    for (const entry of entries) {
      await walk(entry, '');
    }
    if (collected.length) {
      return collected.map((c) => ({
        file: c.file,
        relativePath: c.relativePath.replace(/\\/g, '/'),
      }));
    }
  }
  if (dt.files && dt.files.length) {
    return filesFromFileList(dt.files, false);
  }
  return null;
}

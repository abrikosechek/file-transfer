import { api, apiJson } from '@/shared/lib/apiClient';
import { BASE_PATH } from '@/shared/config';
import type { Retention, TransferFile, TransferItem } from './types';

export async function listItems(): Promise<TransferItem[]> {
  const data = await apiJson<{ items: TransferItem[] }>('/items');
  return data.items || [];
}

export async function getItem(
  slug: string
): Promise<{ item: TransferItem; files: TransferFile[] }> {
  return apiJson(`/items/${encodeURIComponent(slug)}`);
}

export async function renameItem(slug: string, title: string): Promise<TransferItem> {
  const data = await apiJson<{ item: TransferItem }>(`/items/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  return data.item;
}

export async function deleteItem(slug: string): Promise<void> {
  const res = await api(`/items/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || 'Ошибка удаления');
  }
}

export function fileDownloadUrl(slug: string, fileId: string): string {
  return `${BASE_PATH}/api/items/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}/download`;
}

export function filePreviewUrl(slug: string, fileId: string): string {
  return `${BASE_PATH}/api/items/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}/preview`;
}

export function itemShareUrl(slug: string): string {
  return `${location.origin}${BASE_PATH}/?id=${encodeURIComponent(slug)}`;
}

export function itemZipDownloadUrl(slug: string): string {
  return `${BASE_PATH}/api/items/${encodeURIComponent(slug)}/download-zip`;
}

export type UploadStatusFile = {
  file_index: number;
  relative_path: string;
  size_bytes: number;
  chunk_count: number;
  received_chunks: number;
  received_chunk_indices: number[];
  received_bytes: number;
};

export type UploadStatusResponse = {
  upload: {
    id: string;
    title: string;
    retention: Retention | string;
    status: string;
    chunk_size: number;
    total_bytes: number;
    created_at?: string;
    updated_at?: string;
  };
  files: UploadStatusFile[];
  receivedBytes: number;
  totalBytes: number;
};

export async function getUploadStatus(uploadId: string): Promise<UploadStatusResponse> {
  return apiJson(`/uploads/${encodeURIComponent(uploadId)}`);
}

export async function abortUpload(uploadId: string): Promise<void> {
  await api(`/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
}

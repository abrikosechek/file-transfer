import { useEffect, useState } from 'react';
import { Modal } from '@/shared/ui/Modal';
import { useToast } from '@/shared/ui/Toast';
import { formatBytes, formatExpires } from '@/shared/lib/format';
import { ApiError } from '@/shared/lib/apiClient';
import { getQueryId, setQueryId } from '@/shared/lib/queryId';
import {
  deleteItem,
  downloadAllContents,
  downloadAsStoreZip,
  fileDownloadUrl,
  getItem,
  itemShareUrl,
  renameItem,
  supportsDirectoryPicker,
  type TransferFile,
  type TransferItem,
} from '@/modules/transfers';
import { Preview } from './Preview';

type Props = {
  slug: string | null;
  onClose: () => void;
  onChanged: () => void;
  onUnauthorized: () => void;
};

export function ItemModal({ slug, onClose, onChanged, onUnauthorized }: Props) {
  const toast = useToast();
  const [item, setItem] = useState<TransferItem | null>(null);
  const [files, setFiles] = useState<TransferFile[]>([]);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState('');
  const [dlLabel, setDlLabel] = useState('Скачать');
  const [dlBusy, setDlBusy] = useState(false);
  const [dlDetail, setDlDetail] = useState('');

  const multi = !!item && (item.kind === 'folder' || files.length > 1);

  useEffect(() => {
    if (!slug) {
      setItem(null);
      setFiles([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setError('');
      setDlDetail('');
      try {
        const data = await getItem(slug);
        if (cancelled) return;
        setItem(data.item);
        setFiles(data.files || []);
        setRenameValue(data.item.title);
        setQueryId(slug);
        if (data.item.kind === 'folder' || (data.files || []).length > 1) {
          setDlLabel(
            supportsDirectoryPicker()
              ? 'Скачать всё в папку'
              : 'Скачать всё'
          );
        } else {
          setDlLabel('Скачать');
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          toast.show('Файл не найден или истёк', 'err');
          setQueryId(null);
          onClose();
          return;
        }
        toast.show(err instanceof Error ? err.message : 'Ошибка', 'err');
        onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, onClose, onUnauthorized, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && slug) handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const handleClose = () => {
    setQueryId(null);
    onClose();
  };

  const link = item ? item.url || itemShareUrl(item.slug) : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.show('Ссылка скопирована');
    } catch {
      toast.show('Не удалось скопировать', 'err');
    }
  };

  const handleRename = async () => {
    if (!item) return;
    const title = renameValue.trim();
    if (!title) return;
    try {
      const updated = await renameItem(item.slug, title);
      setItem({ ...item, title: updated.title });
      toast.show('Переименовано');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!confirm(`Удалить «${item.title}»?`)) return;
    try {
      await deleteItem(item.slug);
      handleClose();
      toast.show('Удалено');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  };

  const resetDlLabel = () => {
    if (multi) {
      setDlLabel(supportsDirectoryPicker() ? 'Скачать всё в папку' : 'Скачать всё');
    } else {
      setDlLabel('Скачать');
    }
  };

  const handleDownload = async () => {
    if (!item || !files.length) return;
    if (item.kind === 'folder' || files.length > 1) {
      setDlBusy(true);
      setDlDetail(
        supportsDirectoryPicker()
          ? 'Выберите папку на диске — сохранится дерево файлов.'
          : 'Браузер скачает файлы по одному в «Загрузки».'
      );
      try {
        const result = await downloadAllContents(item, files, (p) => {
          const name = p.currentName ? ` · ${p.currentName}` : '';
          const fail = p.failed ? ` · ошибок: ${p.failed}` : '';
          if (p.phase === 'picking') {
            setDlLabel('Выбор папки…');
            setDlDetail('Укажите каталог, куда сохранить содержимое.');
            return;
          }
          setDlLabel(`Скачивание ${p.done}/${p.total}${fail}`);
          setDlDetail(p.currentName ? `Сейчас: ${p.currentName}` : '');
        });
        if (result.usedFallback && result.fallbackHint) {
          toast.show(result.fallbackHint);
        }
        if (result.failed > 0) {
          toast.show(
            `Скачано ${result.count} из ${files.length}, ошибок: ${result.failed}. Можно нажать снова — уже скачанные можно перезаписать.`,
            'err'
          );
          if (result.errors[0]) {
            setError(`${result.errors[0].path}: ${result.errors[0].error}`);
          }
        } else {
          toast.show(`Скачано файлов: ${result.count}`);
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          toast.show('Выбор папки отменён');
          return;
        }
        console.error(err);
        toast.show(err instanceof Error ? err.message : 'Ошибка скачивания', 'err');
      } finally {
        setDlBusy(false);
        setDlDetail('');
        resetDlLabel();
      }
      return;
    }
    window.open(fileDownloadUrl(item.slug, files[0].id), '_blank');
  };

  const handleZip = () => {
    if (!item || !files.length) return;
    downloadAsStoreZip(item);
    toast.show('Скачивание одним ZIP без сжатия…');
  };

  useEffect(() => {
    if (!slug && getQueryId()) setQueryId(null);
  }, [slug]);

  return (
    <Modal open={!!slug && !!item} onClose={handleClose} wide>
      {item && (
        <>
          <div className="modal-header">
            <h2>{item.title}</h2>
            <button type="button" className="icon" aria-label="Закрыть" onClick={handleClose}>
              ✕
            </button>
          </div>
          <div className="modal-body">
            <div className="preview-area">
              <Preview item={item} files={files} />
            </div>
            <dl className="meta-grid">
              <dt>Размер</dt>
              <dd>{item.size_label || formatBytes(item.size_bytes)}</dd>
              <dt>Истекает</dt>
              <dd>{formatExpires(item.expires_at)}</dd>
              <dt>Ссылка</dt>
              <dd>{link}</dd>
            </dl>
            <div className="rename-row">
              <input
                type="text"
                maxLength={200}
                placeholder="Новое название"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
              />
              <button type="button" className="ghost" onClick={() => void handleRename()}>
                Переименовать
              </button>
            </div>
            {dlDetail && <div className="dl-detail">{dlDetail}</div>}
            <div className="error-msg">{error}</div>
          </div>
          <div className="modal-footer">
            <button type="button" className="ghost" onClick={() => void handleCopy()}>
              Копировать ссылку
            </button>
            {files.length > 0 && (
              <button type="button" disabled={dlBusy} onClick={() => void handleDownload()}>
                {dlLabel}
              </button>
            )}
            {multi && files.length > 0 && (
              <button
                type="button"
                className="ghost"
                disabled={dlBusy}
                title="Один файл ZIP без сжатия (STORE) — удобно в Firefox"
                onClick={handleZip}
              >
                Скачать одним файлом (без сжатия)
              </button>
            )}
            <button type="button" className="danger" onClick={() => void handleDelete()}>
              Удалить
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

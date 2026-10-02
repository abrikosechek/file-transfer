import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Modal } from '@/shared/ui/Modal';
import { formatBytes } from '@/shared/lib/format';
import { useToast } from '@/shared/ui/Toast';
import { ApiError } from '@/shared/lib/apiClient';
import {
  abortUpload,
  clearPersistedUpload,
  collectFromDataTransfer,
  filesFromFileList,
  getUploadStatus,
  guessTitlePlaceholder,
  loadPersistedUpload,
  matchSelectedToPersisted,
  startChunkedUpload,
  summarizePersisted,
  type PersistedUpload,
  type Retention,
  type SelectedFile,
  type TransferItem,
} from '@/modules/transfers';

type Props = {
  open: boolean;
  onClose: () => void;
  onUploaded: (item: TransferItem) => void;
};

export function CreateTransferModal({ open, onClose, onUploaded }: Props) {
  const toast = useToast();
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const [title, setTitle] = useState('');
  const [placeholder, setPlaceholder] = useState('');
  const [retention, setRetention] = useState<Retention>('24h');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ loaded: 0, total: 0, label: 'Загрузка…', active: false });
  const [dragover, setDragover] = useState(false);
  const [pending, setPending] = useState<PersistedUpload | null>(null);
  const [pendingInfo, setPendingInfo] = useState('');
  const [matchedResume, setMatchedResume] = useState(false);
  const cancelRef = useRef<(() => Promise<void>) | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setTitle('');
    setPlaceholder('');
    setRetention('24h');
    setError('');
    setUploading(false);
    setProgress({ loaded: 0, total: 0, label: 'Загрузка…', active: false });
    setMatchedResume(false);
    cancelRef.current = null;

    let cancelled = false;
    (async () => {
      const local = loadPersistedUpload();
      if (!local) {
        setPending(null);
        setPendingInfo('');
        return;
      }
      try {
        const status = await getUploadStatus(local.uploadId);
        if (cancelled) return;
        if (status.upload.status !== 'pending') {
          clearPersistedUpload(local.uploadId);
          setPending(null);
          setPendingInfo('');
          if (status.upload.status === 'completed') {
            toast.show('Незавершённая загрузка уже была завершена');
          }
          return;
        }
        const recv = status.receivedBytes || 0;
        const total = status.totalBytes || local.totalBytes;
        const pct = total > 0 ? Math.min(100, Math.round((recv / total) * 100)) : 0;
        setPending(local);
        setTitle(local.title || '');
        setRetention((local.retention as Retention) || '24h');
        setPendingInfo(
          `${summarizePersisted(local)} · на сервере ${pct}% (${formatBytes(recv)} / ${formatBytes(total)}). Выберите те же файлы или папку, чтобы продолжить.`
        );
      } catch (err) {
        if (cancelled) return;
        clearPersistedUpload(local.uploadId);
        setPending(null);
        setPendingInfo('');
        if (err instanceof ApiError && err.status === 404) {
          toast.show('Сессия загрузки истекла или удалена — начните заново');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open && !uploading) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, uploading, onClose]);

  const applyFiles = (files: SelectedFile[]) => {
    setSelected(files);
    setPlaceholder(guessTitlePlaceholder(files));
    if (pending) {
      const matched = matchSelectedToPersisted(files, pending);
      setMatchedResume(!!matched);
      if (!matched) {
        setError(
          'Выбранные файлы не совпадают с незавершённой загрузкой (нужны те же путь, размер и дата изменения). Можно начать новую — сначала отмените незавершённую.'
        );
      } else {
        setError('');
      }
    } else {
      setMatchedResume(false);
      setError('');
    }
  };

  const discardPending = async () => {
    if (!pending || uploading) return;
    try {
      await abortUpload(pending.uploadId);
    } catch {
      /* ignore */
    }
    clearPersistedUpload(pending.uploadId);
    setPending(null);
    setPendingInfo('');
    setMatchedResume(false);
    toast.show('Незавершённая загрузка отменена');
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragover(false);
    if (uploading) return;
    const collected = await collectFromDataTransfer(e.dataTransfer);
    if (collected?.length) applyFiles(collected);
  };

  const summary =
    selected.length === 0
      ? null
      : (() => {
          const total = selected.reduce((s, f) => s + f.file.size, 0);
          const names = selected.slice(0, 8).map((f) => f.relativePath);
          const more = selected.length > 8 ? `\n… и ещё ${selected.length - 8}` : '';
          return `${selected.length} файл(ов), ${formatBytes(total)}\n${names.join('\n')}${more}`;
        })();

  const handleCancel = async () => {
    if (!uploading) {
      onClose();
      return;
    }
    setProgress((p) => ({ ...p, label: 'Отмена…' }));
    await cancelRef.current?.();
    cancelRef.current = null;
    setUploading(false);
    setProgress({ loaded: 0, total: 0, label: 'Загрузка…', active: false });
    setPending(null);
    setPendingInfo('');
    setMatchedResume(false);
    setError('Загрузка отменена');
    toast.show('Загрузка отменена');
  };

  const handleSubmit = async (e?: FormEvent, resume = false) => {
    e?.preventDefault();
    if (uploading || !selected.length) return;

    let filesForUpload = selected;
    let resumeId: string | undefined;

    if (resume) {
      if (!pending) return;
      const matched = matchSelectedToPersisted(selected, pending);
      if (!matched) {
        setError('Для продолжения выберите те же файлы/папку (путь + размер + дата изменения).');
        return;
      }
      filesForUpload = matched;
      resumeId = pending.uploadId;
    } else if (pending) {
      setError('Сначала отмените незавершённую загрузку или продолжите её теми же файлами.');
      return;
    }

    const finalTitle = title.trim() || placeholder || '';
    setError('');
    setUploading(true);
    setProgress({ loaded: 0, total: 0, label: resume ? 'Продолжение…' : 'Загрузка…', active: true });

    const controller = startChunkedUpload(filesForUpload, {
      title: finalTitle,
      retention,
      resumeUploadId: resumeId,
      onProgress: (p) => {
        if (p.phase === 'cancelling') {
          setProgress((prev) => ({ ...prev, label: 'Отмена…' }));
          return;
        }
        if (p.phase === 'finalizing') {
          setProgress({
            loaded: p.loaded,
            total: p.total,
            label: 'Завершение…',
            active: true,
          });
          return;
        }
        const pct = p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
        setProgress({
          loaded: p.loaded,
          total: p.total,
          label: `${resume ? 'Продолжение' : 'Загрузка'}… ${pct}% (${formatBytes(p.loaded)} / ${formatBytes(p.total)})`,
          active: true,
        });
      },
    });
    cancelRef.current = controller.cancel;

    try {
      const { item } = await controller.promise;
      cancelRef.current = null;
      setUploading(false);
      setPending(null);
      setPendingInfo('');
      toast.show('Загрузка завершена');
      onUploaded(item);
      onClose();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error(err);
      cancelRef.current = null;
      setUploading(false);
      setProgress((p) => ({ ...p, label: 'Ошибка — можно продолжить после обновления страницы', active: true }));
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      // Refresh pending banner from storage
      const local = loadPersistedUpload();
      setPending(local);
      if (local) {
        setPendingInfo(
          `${summarizePersisted(local)}. После сбоя можно снова выбрать те же файлы и нажать «Продолжить».`
        );
      }
    }
  };

  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

  return (
    <Modal open={open} onClose={uploading ? undefined : onClose} closeOnBackdrop={!uploading}>
      <div className="modal-header">
        <h2>Новая передача</h2>
        <button
          type="button"
          className="icon"
          aria-label="Закрыть"
          disabled={uploading}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="modal-body">
        {pending && !uploading && (
          <div className="resume-banner">
            <strong>Незавершённая загрузка</strong>
            <p>{pendingInfo}</p>
            <div className="resume-actions">
              <button type="button" className="ghost danger-text" onClick={() => void discardPending()}>
                Отменить незавершённую
              </button>
            </div>
          </div>
        )}

        <div
          className={`dropzone${dragover ? ' dragover' : ''}`}
          tabIndex={0}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragover(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragover(true);
          }}
          onDragLeave={() => setDragover(false)}
          onDrop={onDrop}
        >
          <strong>Перетащите файлы или папку сюда</strong>
          <div>или выберите ниже</div>
          <div className="file-picks">
            <button
              type="button"
              className="ghost"
              disabled={uploading}
              onClick={(e) => {
                e.stopPropagation();
                filesInput.current?.click();
              }}
            >
              Файлы
            </button>
            <button
              type="button"
              className="ghost"
              disabled={uploading}
              onClick={(e) => {
                e.stopPropagation();
                folderInput.current?.click();
              }}
            >
              Папка
            </button>
          </div>
          <input
            ref={filesInput}
            type="file"
            className="hidden"
            multiple
            onChange={(e) => {
              if (e.target.files?.length) applyFiles(filesFromFileList(e.target.files, false));
              e.target.value = '';
            }}
          />
          <input
            ref={(el) => {
              folderInput.current = el;
              if (el) el.setAttribute('webkitdirectory', '');
            }}
            type="file"
            className="hidden"
            multiple
            onChange={(e) => {
              if (e.target.files?.length) applyFiles(filesFromFileList(e.target.files, true));
              e.target.value = '';
            }}
          />
        </div>

        {matchedResume && (
          <div className="resume-match ok">Файлы совпали с незавершённой загрузкой — можно продолжить.</div>
        )}

        {summary && <div className="file-summary">{summary}</div>}

        <div className="field">
          <label htmlFor="create-title">Название</label>
          <input
            id="create-title"
            type="text"
            maxLength={200}
            placeholder={placeholder || 'Необязательно — подставится из имени файла'}
            value={title}
            disabled={uploading}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Срок хранения</label>
          <div className="retention">
            {(
              [
                ['1h', '1 час'],
                ['24h', '24 часа'],
                ['3d', '3 дня'],
                ['7d', '7 дней'],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="retention"
                  value={value}
                  checked={retention === value}
                  disabled={uploading}
                  onChange={() => setRetention(value)}
                />{' '}
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className={`progress-wrap${progress.active ? ' active' : ''}`}>
          <div className="progress-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="progress-label">{progress.label}</div>
        </div>

        <div className="error-msg">{error}</div>
      </div>
      <div className="modal-footer">
        <button type="button" className="ghost" onClick={() => void handleCancel()}>
          {uploading ? 'Отменить загрузку' : 'Отмена'}
        </button>
        {pending && (
          <button
            type="button"
            disabled={uploading || !matchedResume}
            onClick={() => void handleSubmit(undefined, true)}
          >
            Продолжить
          </button>
        )}
        <button
          type="button"
          disabled={uploading || !selected.length || !!pending}
          onClick={() => void handleSubmit(undefined, false)}
          title={pending ? 'Сначала отмените или продолжите незавершённую' : undefined}
        >
          Загрузить
        </button>
      </div>
    </Modal>
  );
}

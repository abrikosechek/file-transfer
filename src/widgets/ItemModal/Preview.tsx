import { useEffect, useState } from 'react';
import { formatBytes, isPreviewableMime } from '@/shared/lib/format';
import { fileDownloadUrl, filePreviewUrl } from '@/modules/transfers';
import type { TransferFile, TransferItem } from '@/modules/transfers';

type Props = {
  item: TransferItem;
  files: TransferFile[];
};

export function Preview({ item, files }: Props) {
  const [focus, setFocus] = useState<TransferFile | null>(null);

  useEffect(() => {
    setFocus(null);
  }, [item.slug]);

  if (focus) {
    return <SinglePreview item={item} file={focus} onBack={() => setFocus(null)} />;
  }

  if (item.kind === 'folder' || files.length > 1) {
    return (
      <ul className="tree">
        {files.map((f) => (
          <li
            key={f.id}
            style={isPreviewableMime(f.mime) ? { cursor: 'pointer' } : undefined}
            onClick={() => {
              if (isPreviewableMime(f.mime)) setFocus(f);
            }}
          >
            <span className="name" title={f.relative_path}>
              {f.relative_path}
            </span>
            <span className="sz">{f.size_label || formatBytes(f.size_bytes)}</span>
            <button
              type="button"
              className="ghost"
              title="Скачать"
              onClick={(e) => {
                e.stopPropagation();
                window.open(fileDownloadUrl(item.slug, f.id), '_blank');
              }}
            >
              ⬇
            </button>
          </li>
        ))}
      </ul>
    );
  }

  if (files[0]) return <SinglePreview item={item} file={files[0]} />;

  return (
    <div className="preview-placeholder">
      <div className="big">📄</div>Нет файлов
    </div>
  );
}

function SinglePreview({
  item,
  file,
  onBack,
}: {
  item: TransferItem;
  file: TransferFile;
  onBack?: () => void;
}) {
  const m = file.mime || '';
  const previewUrl = filePreviewUrl(item.slug, file.id);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (
      !(
        m.startsWith('text/') ||
        ['application/json', 'application/javascript', 'application/xml'].includes(m)
      )
    ) {
      return;
    }
    let cancelled = false;
    setText('Загрузка…');
    fetch(previewUrl, { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch(() => {
        if (!cancelled) setText('Не удалось загрузить превью');
      });
    return () => {
      cancelled = true;
    };
  }, [previewUrl, m]);

  return (
    <div
      style={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '.5rem',
      }}
    >
      {onBack && (
        <button type="button" className="ghost" onClick={onBack}>
          ← К списку
        </button>
      )}
      {m.startsWith('image/') && <img src={`${previewUrl}?w=1200`} alt={file.relative_path} />}
      {m.startsWith('video/') && <video src={previewUrl} controls />}
      {m === 'application/pdf' && <iframe src={previewUrl} title={file.relative_path} />}
      {(m.startsWith('text/') ||
        ['application/json', 'application/javascript', 'application/xml'].includes(m)) && (
        <pre>{text ?? 'Загрузка…'}</pre>
      )}
      {!isPreviewableMime(m) && (
        <div className="preview-placeholder">
          <div className="big">📦</div>
          Превью недоступно
          <br />
          <small>{file.relative_path}</small>
        </div>
      )}
    </div>
  );
}

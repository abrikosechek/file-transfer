import { formatBytes, formatExpires } from '@/shared/lib/format';
import type { TransferItem } from '@/modules/transfers';

type Props = {
  items: TransferItem[];
  onOpen: (slug: string) => void;
};

export function ItemList({ items, onOpen }: Props) {
  if (!items.length) {
    return (
      <div className="empty">
        <strong>Пока пусто</strong>
        Нет активных загрузок. Нажмите «Создать», чтобы отправить файл или папку.
      </div>
    );
  }

  return (
    <div className="list">
      {items.map((it) => (
        <div
          key={it.slug}
          className="item-row"
          tabIndex={0}
          role="button"
          onClick={() => onOpen(it.slug)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpen(it.slug);
            }
          }}
        >
          <div className="item-icon">{it.kind === 'folder' ? '📁' : '📄'}</div>
          <div className="item-meta">
            <div className="title">{it.title}</div>
            <div className="sub">
              <span>{it.kind === 'folder' ? 'Папка' : 'Файл'}</span>
              <span>·</span>
              <span>{it.size_label || formatBytes(it.size_bytes)}</span>
            </div>
          </div>
          <div className="item-expiry">до {formatExpires(it.expires_at)}</div>
        </div>
      ))}
    </div>
  );
}

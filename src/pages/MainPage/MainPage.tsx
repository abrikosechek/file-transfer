import { useCallback, useEffect, useState } from 'react';
import { Header } from '@/widgets/Header';
import { ItemList } from '@/widgets/ItemList';
import { CreateTransferModal } from '@/widgets/CreateTransferModal';
import { ItemModal } from '@/widgets/ItemModal';
import { useItems, type TransferItem } from '@/modules/transfers';
import { getQueryId } from '@/shared/lib/queryId';

type Props = {
  onLogout: () => void;
};

export function MainPage({ onLogout }: Props) {
  const handleUnauthorized = useCallback(() => {
    onLogout();
  }, [onLogout]);

  const { items, reload } = useItems(handleUnauthorized);
  const [createOpen, setCreateOpen] = useState(false);
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  useEffect(() => {
    void reload().then(() => {
      const id = getQueryId();
      if (id) setOpenSlug(id);
    });
  }, [reload]);

  const onUploaded = (item: TransferItem) => {
    void reload();
    if (item.slug) setOpenSlug(item.slug);
  };

  return (
    <section id="main-view">
      <Header onCreate={() => setCreateOpen(true)} onLogout={onLogout} />
      <div className="container">
        <ItemList items={items} onOpen={setOpenSlug} />
      </div>
      <CreateTransferModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onUploaded={onUploaded}
      />
      <ItemModal
        slug={openSlug}
        onClose={() => setOpenSlug(null)}
        onChanged={() => void reload()}
        onUnauthorized={handleUnauthorized}
      />
    </section>
  );
}

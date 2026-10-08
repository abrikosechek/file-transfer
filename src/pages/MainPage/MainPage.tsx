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
  // Read ?id synchronously on mount: ItemModal clears the query when slug is null,
  // so waiting for the list to load would lose the deep link.
  const [openSlug, setOpenSlug] = useState<string | null>(() => getQueryId());

  useEffect(() => {
    void reload();
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

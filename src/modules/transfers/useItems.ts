import { useCallback, useState } from 'react';
import { ApiError } from '@/shared/lib/apiClient';
import { listItems } from './api';
import type { TransferItem } from './types';

export function useItems(onUnauthorized?: () => void) {
  const [items, setItems] = useState<TransferItem[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listItems();
      setItems(list);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  return { items, loading, reload, setItems };
}

import { useCallback, useEffect, useState } from 'react';
import { fetchMe, login as loginApi, logout as logoutApi } from './api';

type AuthState = {
  loading: boolean;
  authenticated: boolean;
  error: string | null;
};

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    loading: true,
    authenticated: false,
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const ok = await fetchMe();
      setState({ loading: false, authenticated: ok, error: null });
      return ok;
    } catch {
      setState({ loading: false, authenticated: false, error: 'Сервер недоступен' });
      return false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (password: string) => {
    await loginApi(password);
    setState({ loading: false, authenticated: true, error: null });
  }, []);

  const logout = useCallback(async () => {
    await logoutApi();
    setState({ loading: false, authenticated: false, error: null });
  }, []);

  return { ...state, refresh, login, logout };
}

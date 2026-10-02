import { api, apiJson } from '@/shared/lib/apiClient';

export async function fetchMe(): Promise<boolean> {
  const data = await apiJson<{ authenticated: boolean }>('/me');
  return !!data.authenticated;
}

export async function login(password: string): Promise<void> {
  await apiJson('/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  await api('/logout', { method: 'POST' });
}

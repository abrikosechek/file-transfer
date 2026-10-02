import { useState, type FormEvent } from 'react';
import { ApiError } from '@/shared/lib/apiClient';

type Props = {
  login: (password: string) => Promise<void>;
  initialError?: string | null;
};

export function LoginPage({ login, initialError }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError || '');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(password);
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="login-view">
      <div className="login-card">
        <h1>Transfer Files</h1>
        <p className="sub">Введите пароль для доступа к обмену файлами</p>
        <form onSubmit={(e) => void onSubmit(e)}>
          <div className="row">
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" disabled={busy}>
            Войти
          </button>
          <div className="error-msg">{error}</div>
        </form>
      </div>
    </section>
  );
}

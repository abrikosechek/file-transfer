import { ToastProvider } from '@/shared/ui/Toast';
import { useAuth } from '@/modules/auth';
import { LoginPage } from '@/pages/LoginPage';
import { MainPage } from '@/pages/MainPage';

function Root() {
  const auth = useAuth();

  if (auth.loading) {
    return <div id="app" />;
  }

  if (!auth.authenticated) {
    return (
      <div id="app">
        <LoginPage login={auth.login} initialError={auth.error} />
      </div>
    );
  }

  return (
    <div id="app">
      <MainPage onLogout={() => void auth.logout()} />
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

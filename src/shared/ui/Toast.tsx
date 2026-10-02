import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type ToastKind = 'ok' | 'err';

type Toast = {
  id: number;
  msg: string;
  kind: ToastKind;
  exiting: boolean;
};

type ToastApi = {
  show: (msg: string, kind?: ToastKind) => void;
};

const ToastContext = createContext<ToastApi | null>(null);
const TOAST_LIFETIME = 2800;
const TOAST_EXIT_DURATION = 220;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const exitTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }

    setToasts((current) =>
      current.map((toast) => (toast.id === id ? { ...toast, exiting: true } : toast)),
    );

    const exitTimer = setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
      exitTimers.current.delete(id);
    }, TOAST_EXIT_DURATION);
    exitTimers.current.set(id, exitTimer);
  }, []);

  const show = useCallback((msg: string, kind: ToastKind = 'ok') => {
    const id = ++nextId.current;
    setToasts((current) => [{ id, msg, kind, exiting: false }, ...current]);

    const timer = setTimeout(() => dismiss(id), TOAST_LIFETIME);
    timers.current.set(id, timer);
  }, [dismiss]);

  useEffect(() => () => {
    timers.current.forEach((timer) => clearTimeout(timer));
    exitTimers.current.forEach((timer) => clearTimeout(timer));
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? (
        <div className="toast-container" aria-live="polite" aria-atomic="false">
          {toasts.map((toast) => (
            <div
              className={`toast ${toast.kind}${toast.exiting ? ' toast-exiting' : ''}`}
              key={toast.id}
              role="status"
            >
              {toast.msg}
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

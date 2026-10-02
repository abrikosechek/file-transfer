import type { ReactNode, MouseEvent } from 'react';

type Props = {
  open: boolean;
  onClose?: () => void;
  wide?: boolean;
  children: ReactNode;
  closeOnBackdrop?: boolean;
};

export function Modal({ open, onClose, wide, children, closeOnBackdrop = true }: Props) {
  if (!open) return null;

  const onBackdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && closeOnBackdrop) onClose?.();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onBackdrop}>
      <div className={`modal${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  );
}

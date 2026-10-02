type Props = {
  onCreate: () => void;
  onLogout: () => void;
};

export function Header({ onCreate, onLogout }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <h1>Transfer Files</h1>
        <div className="actions">
          <button type="button" onClick={onCreate}>
            Создать
          </button>
          <button type="button" className="ghost" onClick={onLogout}>
            Выйти
          </button>
        </div>
      </div>
    </header>
  );
}

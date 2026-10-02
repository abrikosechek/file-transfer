export function formatBytes(n: number | string | null | undefined): string {
  const num = Number(n) || 0;
  if (num < 1024) return `${num} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = num;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatExpires(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function sanitizeDirectoryName(name: string): string {
  let safe = String(name || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/[ .]+$/g, '')
    .trim();
  if (!safe || safe === '.' || safe === '..') safe = 'item';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) safe = `_${safe}`;
  return safe.slice(0, 120) || 'item';
}

export function pathBasename(p: string): string {
  const parts = String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  return parts[parts.length - 1] || 'file';
}

export function splitRelPath(relativePath: string): { dirs: string[]; fileName: string } {
  const parts = String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  const fileName = parts.pop() || 'file';
  return { dirs: parts, fileName };
}

export function isPreviewableMime(m: string | null | undefined): boolean {
  if (!m) return false;
  return (
    m.startsWith('image/') ||
    m.startsWith('video/') ||
    m === 'application/pdf' ||
    m.startsWith('text/') ||
    ['application/json', 'application/javascript', 'application/xml'].includes(m)
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

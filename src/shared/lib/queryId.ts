export function getQueryId(): string | null {
  return new URLSearchParams(location.search).get('id');
}

export function setQueryId(slug: string | null): void {
  const url = new URL(location.href);
  if (slug) url.searchParams.set('id', slug);
  else url.searchParams.delete('id');
  history.replaceState(null, '', url);
}

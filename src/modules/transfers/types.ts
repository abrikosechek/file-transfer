export type TransferItem = {
  id?: string;
  slug: string;
  title: string;
  kind: 'file' | 'folder';
  size_bytes: number;
  size_label?: string;
  expires_at: string;
  url?: string;
  path_url?: string;
};

export type TransferFile = {
  id: string;
  relative_path: string;
  size_bytes: number;
  size_label?: string;
  mime?: string | null;
};

export type SelectedFile = {
  file: File;
  relativePath: string;
};

export type Retention = '1h' | '24h' | '3d' | '7d';

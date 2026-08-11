export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  url: string;
  origin?: 'upstream' | 'frosthold';
}

export interface Manifest {
  schemaVersion: number;
  realm: string;
  version: string;
  upstreamVersion: string | null;
  generated: string;
  gameDir: string;
  executableName: string;
  clientLocale: string;
  realmlistHost: string;
  totalFiles: number;
  totalSize: number;
  requiredFreeSpace: number;
  files: ManifestFile[];
}

/** Lo que sabemos de un archivo ya escrito en disco. Evita rehashear 16 GB en cada arranque. */
export interface InstalledEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export type InstalledRecord = Record<string, InstalledEntry>;

export interface DownloadProgress {
  /** Archivos ya completos y verificados. */
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** Media móvil, bytes por segundo. */
  speed: number;
  /** Segundos restantes estimados, o null si aún no hay medida fiable. */
  etaSeconds: number | null;
  current: string[];
}

export type Phase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready'
  | 'error';

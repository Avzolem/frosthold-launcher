import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LauncherConfig {
  installDir: string | null;
  locale: string | null;
  lastVersion: string | null;
  acceptedTerms: boolean;
  closeOnLaunch: boolean;
}

const DEFAULTS: LauncherConfig = {
  installDir: null,
  locale: null,
  lastVersion: null,
  acceptedTerms: false,
  closeOnLaunch: true,
};

export class ConfigStore {
  private file: string;
  private data: LauncherConfig;
  /**
   * Si no se pudo guardar, hay que decirlo: el síntoma es que el launcher
   * olvida la carpeta del juego en cada arranque y obliga a elegirla otra vez
   * sin explicar nunca por qué.
   */
  private lastError: string | null = null;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'config.json');
    this.data = { ...DEFAULTS, ...this.load() };
  }

  get(): LauncherConfig {
    return { ...this.data };
  }

  /** Motivo del último fallo al guardar, o null si todo va bien. */
  getError(): string | null {
    return this.lastError;
  }

  update(patch: Partial<LauncherConfig>): LauncherConfig {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.get();
  }

  private load(): Partial<LauncherConfig> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      this.lastError = null;
    } catch (err) {
      // El launcher sigue funcionando esta sesión, pero no lo recordará la
      // próxima. Se guarda el motivo para poder enseñarlo.
      this.lastError =
        'No se pudieron guardar tus preferencias, así que el launcher no recordará la carpeta del juego la próxima vez. ' +
        `Motivo: ${(err as Error).message}`;
    }
  }
}

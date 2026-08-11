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

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'config.json');
    this.data = { ...DEFAULTS, ...this.load() };
  }

  get(): LauncherConfig {
    return { ...this.data };
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
    } catch {
      /* si no se puede guardar, el launcher sigue funcionando esta sesión */
    }
  }
}

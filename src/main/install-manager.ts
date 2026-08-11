import { access, cp, mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

/** Idiomas que puede traer un cliente 3.3.5a. El nuestro es esMX. */
const LOCALES = ['esMX', 'esES', 'enUS', 'enGB', 'ptBR', 'frFR', 'deDE', 'ruRU'];
const MAX_BACKUPS = 5;

export interface ClientCheck {
  ok: boolean;
  path: string;
  executable: string | null;
  locale: string | null;
  /** Qué falta, en lenguaje llano, para poder decírselo al jugador. */
  problems: string[];
}

export class InstallManager {
  /**
   * Reconoce un cliente ya instalado. Aceptamos cualquier ejecutable conocido
   * porque quien ya jugaba en otro servidor lo tendrá con otro nombre, y
   * obligarle a renombrarlo a mano es justo la fricción que queremos quitar.
   */
  async inspect(dir: string, executableName: string): Promise<ClientCheck> {
    const problems: string[] = [];
    const result: ClientCheck = {
      ok: false,
      path: dir,
      executable: null,
      locale: null,
      problems,
    };

    try {
      const st = await stat(dir);
      if (!st.isDirectory()) {
        problems.push('La ruta indicada no es una carpeta.');
        return result;
      }
    } catch {
      problems.push('La carpeta no existe.');
      return result;
    }

    const candidates = [executableName, 'Wow.exe', 'WoW.exe', 'wow.exe'];
    for (const name of candidates) {
      if (await this.exists(join(dir, name))) {
        result.executable = name;
        break;
      }
    }
    if (!result.executable) problems.push('No se encontró el ejecutable del juego.');

    result.locale = await this.detectLocale(dir);
    if (!result.locale) problems.push('No se encontró la carpeta de idioma dentro de Data.');

    // Sin estos dos, no hay cliente que valga: son el grueso de los datos.
    for (const mpq of ['Data/common.MPQ', 'Data/lichking.MPQ']) {
      if (!(await this.exists(join(dir, mpq)))) problems.push(`Falta ${mpq}.`);
    }

    result.ok = problems.length === 0;
    return result;
  }

  async detectLocale(dir: string): Promise<string | null> {
    for (const l of LOCALES) {
      if (await this.exists(join(dir, 'Data', l))) return l;
    }
    // Puede haber un idioma que no esté en la lista: buscamos por estructura.
    try {
      for (const name of await readdir(join(dir, 'Data'))) {
        if (/^[a-z]{2}[A-Z]{2}$/.test(name)) return name;
      }
    } catch {
      /* sin carpeta Data */
    }
    return null;
  }

  /**
   * Escribe el realmlist en la carpeta de idioma. Este es el paso que más
   * gente falla a mano: el archivo de la raíz de Data no sirve, tiene que
   * estar dentro del idioma, y el cliente lo reescribe si lo dejas vacío.
   */
  async applyRealmlist(dir: string, host: string, locale?: string): Promise<string> {
    const loc = locale ?? (await this.detectLocale(dir));
    if (!loc) throw new Error('No se pudo determinar el idioma del cliente');

    const target = join(dir, 'Data', loc, 'realmlist.wtf');
    await mkdir(join(dir, 'Data', loc), { recursive: true });
    await writeFile(target, `set realmlist ${host}\r\n`, 'utf8');
    return target;
  }

  async readRealmlist(dir: string, locale?: string): Promise<string | null> {
    const loc = locale ?? (await this.detectLocale(dir));
    if (!loc) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(join(dir, 'Data', loc, 'realmlist.wtf'), 'utf8');
      return raw.match(/set\s+realmlist\s+(\S+)/i)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Copia la carpeta WTF antes de tocar nada. Ahí viven las cuentas guardadas,
   * los ajustes y las macros del jugador: si se pierde, se nota.
   */
  async backupSettings(dir: string): Promise<string | null> {
    const source = join(dir, 'WTF');
    if (!(await this.exists(source))) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = join(dir, '.frosthold', 'backups', `WTF-${stamp}`);
    await mkdir(join(dir, '.frosthold', 'backups'), { recursive: true });
    await cp(source, dest, { recursive: true });
    await this.rotateBackups(join(dir, '.frosthold', 'backups'));
    return dest;
  }

  private async rotateBackups(dir: string) {
    try {
      const entries = (await readdir(dir)).filter((n) => n.startsWith('WTF-')).sort();
      for (const old of entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS))) {
        await rm(join(dir, old), { recursive: true, force: true });
      }
    } catch {
      /* si falla la rotación no vale la pena romper la instalación */
    }
  }

  async freeSpace(dir: string): Promise<number> {
    try {
      const fs = await statfs(dir);
      return fs.bavail * fs.bsize;
    } catch {
      return -1;
    }
  }

  async ensureWritable(dir: string): Promise<boolean> {
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await access(p, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

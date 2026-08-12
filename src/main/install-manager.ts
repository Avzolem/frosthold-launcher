import { access, cp, mkdir, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

/** Idiomas que puede traer un cliente 3.3.5a. El nuestro es esMX. */
const LOCALES = ['esMX', 'esES', 'enUS', 'enGB', 'ptBR', 'frFR', 'deDE', 'ruRU'];
const MAX_BACKUPS = 5;

/**
 * Ventana de 1280x720 a 60 Hz por D3D9. No es una configuración bonita: es la
 * que arranca en cualquier equipo con Windows que pueda mover el juego. Desde
 * dentro el jugador ya sube lo que quiera.
 */
const SAFE_GRAPHICS = [
  'SET gxWindow "1"',
  'SET gxMaximize "0"',
  'SET gxResolution "1280x720"',
  'SET gxRefresh "60"',
  'SET gxApi "D3D9"',
  'SET gxMonitor "0"',
] as const;

export interface ClientCheck {
  ok: boolean;
  path: string;
  executable: string | null;
  locale: string | null;
  /** Qué falta, en lenguaje llano, para poder decírselo al jugador. */
  problems: string[];
}

export interface GraphicsReset {
  configPath: string;
  /** Dónde quedó la copia de WTF, o null si no había nada que copiar. */
  backup: string | null;
  /** Las líneas de vídeo que había antes, para poder enseñárselas al jugador. */
  removed: string[];
  applied: string[];
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

  /**
   * Devuelve el cliente a una configuración gráfica que funciona en cualquier
   * monitor: ventana de 1280x720.
   *
   * El tropiezo más común de 3.3.5a: el jugador elige en pantalla completa una
   * resolución o una frecuencia que su monitor no admite, el cliente la guarda
   * igual y a partir de ahí arranca en negro. No hay forma de arreglarlo desde
   * dentro del juego, porque para entrar al menú de vídeo hay que poder ver.
   *
   * Solo se tocan las claves `SET gx*`, que son las de vídeo. Las teclas
   * asignadas, el sonido y la cuenta recordada viven en las demás líneas y se
   * conservan intactas.
   */
  async resetGraphics(dir: string): Promise<GraphicsReset> {
    const backup = await this.backupSettings(dir);
    const target = join(dir, 'WTF', 'Config.wtf');

    let previas: string[] = [];
    let resto: string[] = [];

    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(target, 'utf8');
      for (const linea of raw.split(/\r?\n/)) {
        if (/^\s*SET\s+gx\w+/i.test(linea)) previas.push(linea.trim());
        else if (linea.trim()) resto.push(linea.trim());
      }
    } catch {
      // Sin Config.wtf no hay nada que rescatar: se escribe uno nuevo y el
      // cliente completa el resto de claves solo en el primer arranque.
      previas = [];
      resto = [];
    }

    // El cliente escribe este archivo con finales de línea de Windows y lo
    // reescribe entero al cerrarse. Respetamos su formato para no dejarle
    // un archivo que luego normalice de forma rara.
    const cuerpo = [...resto, ...SAFE_GRAPHICS].join('\r\n') + '\r\n';
    await mkdir(join(dir, 'WTF'), { recursive: true });
    await writeFile(target, cuerpo, 'utf8');

    return { configPath: target, backup, removed: previas, applied: [...SAFE_GRAPHICS] };
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

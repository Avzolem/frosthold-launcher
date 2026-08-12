import { access, cp, mkdir, readdir, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { diskMessage } from './net-errors';

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

/** Veredicto sobre la carpeta que eligió el jugador, antes de bajar nada. */
export interface TargetCheck {
  path: string;
  /** false = no se puede usar tal cual; hay que elegir otra. */
  usable: boolean;
  writable: boolean;
  /** Bytes libres en la unidad, o null si el sistema no lo quiso decir. */
  freeBytes: number | null;
  /** Motivos por los que NO se puede usar. */
  blockers: string[];
  /** Cosas que conviene saber pero no impiden seguir. */
  warnings: string[];
}

/**
 * Carpetas de Windows que exigen permisos de administrador o que no son sitio
 * para 16,5 GB de juego. Instalar ahí es el clásico «me dice que no puede
 * escribir» que deja a alguien atascado sin entender por qué.
 *
 * Se comprueba por ruta y no solo intentando escribir porque el UAC de Windows
 * tiene virtualización de carpetas: en algunos equipos la escritura «funciona»
 * y los archivos acaban en VirtualStore, invisibles para el juego.
 */
export function protectedWindowsPath(dir: string): string | null {
  if (!dir) return null;
  const p = dir.replace(/\//g, '\\');
  // Solo tiene sentido en rutas con letra de unidad; en otras plataformas la
  // comprobación no aplica y devolvemos null sin más.
  if (!/^[a-zA-Z]:\\/.test(p)) return null;

  const sinUnidad = p.slice(2).replace(/\\+$/, '');
  const bajo = (base: string) =>
    sinUnidad.toLowerCase() === base || sinUnidad.toLowerCase().startsWith(base + '\\');

  if (bajo('\\program files')) return 'Archivos de programa';
  if (bajo('\\program files (x86)')) return 'Archivos de programa (x86)';
  if (bajo('\\programdata')) return 'ProgramData';
  if (bajo('\\windows')) return 'la carpeta de Windows';
  if (bajo('\\users\\default')) return 'el perfil predeterminado de Windows';
  if (/^\\users\\[^\\]+\\(appdata|onedrive)(\\|$)/i.test(sinUnidad)) {
    return sinUnidad.toLowerCase().includes('onedrive') ? 'OneDrive' : 'AppData';
  }
  return null;
}

/** ¿La ruta es la raíz de una unidad (C:\ o /)? */
export function isDriveRoot(dir: string): boolean {
  if (!dir) return false;
  const norm = dir.replace(/\//g, '\\').replace(/\\+$/, '');
  return /^[a-zA-Z]:$/.test(norm) || dir === '/';
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

  /**
   * Todo lo que hay que saber de la carpeta ANTES de empezar a bajar 16,5 GB:
   * si se puede escribir en ella de verdad, cuánto sitio queda y si es una de
   * las carpetas que Windows protege.
   */
  async checkTarget(dir: string, requiredBytes: number): Promise<TargetCheck> {
    const out: TargetCheck = {
      path: dir,
      usable: false,
      writable: false,
      freeBytes: null,
      blockers: [],
      warnings: [],
    };

    if (!dir) {
      out.blockers.push('Falta elegir la carpeta del juego.');
      return out;
    }

    const protegida = protectedWindowsPath(dir);
    if (protegida) {
      out.blockers.push(
        `Esa carpeta está dentro de ${protegida}, que Windows protege: haría falta permiso de administrador y el juego podría no encontrar sus propios archivos. Elige una carpeta tuya, por ejemplo C:\\Juegos\\Frosthold o D:\\Frosthold.`
      );
    }

    if (isDriveRoot(dir)) {
      out.warnings.push(
        'Vas a instalar directamente en la raíz de la unidad. Funciona, pero deja 16,5 GB sueltos ahí; conviene una subcarpeta como \\Frosthold.'
      );
    }

    const escritura = await this.probeWrite(dir);
    out.writable = escritura === null;
    if (escritura) out.blockers.push(escritura);

    const libre = await this.freeSpace(dir);
    out.freeBytes = libre >= 0 ? libre : null;
    if (libre >= 0 && requiredBytes > 0 && libre < requiredBytes) {
      out.blockers.push(
        `No hay espacio suficiente: hacen falta ${gib(requiredBytes)} y quedan ${gib(libre)} libres en esa unidad.`
      );
    } else if (libre >= 0 && requiredBytes > 0 && libre < requiredBytes * 1.15) {
      out.warnings.push(
        `Vas justo de espacio: hacen falta ${gib(requiredBytes)} y quedan ${gib(libre)}.`
      );
    }

    out.usable = out.blockers.length === 0;
    return out;
  }

  /**
   * Escribe y borra un archivo de verdad. `access(W_OK)` miente en Windows más
   * de lo que acierta: informa de los permisos de solo lectura del atributo,
   * no de las ACL ni de los bloqueos, así que una carpeta puede pasar el
   * `access` y fallar al primer archivo.
   *
   * Devuelve null si se pudo escribir, o el motivo en lenguaje llano.
   */
  async probeWrite(dir: string): Promise<string | null> {
    const sonda = join(dir, `.frosthold-prueba-${process.pid}-${Date.now()}`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(sonda, 'frosthold');
      return null;
    } catch (err) {
      return (
        diskMessage(err, dir) ??
        `No se pudo escribir en esa carpeta: ${(err as Error).message}`
      );
    } finally {
      await unlink(sonda).catch(() => {});
    }
  }

  async detectLocale(dir: string, preferred?: string | null): Promise<string | null> {
    const orden = preferred ? [preferred, ...LOCALES.filter((l) => l !== preferred)] : LOCALES;
    for (const l of orden) {
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

  /** Todas las carpetas de idioma que hay dentro de Data. */
  async listLocales(dir: string): Promise<string[]> {
    const found: string[] = [];
    try {
      for (const name of await readdir(join(dir, 'Data'), { withFileTypes: true })) {
        if (name.isDirectory() && /^[a-z]{2}[A-Z]{2}$/.test(name.name)) found.push(name.name);
      }
    } catch {
      /* sin carpeta Data */
    }
    return found.sort();
  }

  /**
   * Escribe el realmlist en TODAS las carpetas de idioma que existan. Este es
   * el paso que más gente falla a mano: el archivo de la raíz de Data no sirve,
   * tiene que estar dentro del idioma.
   *
   * Se escriben todas y no solo la nuestra porque quien reutiliza un cliente
   * que ya tenía —lo normal— puede acabar con dos idiomas en Data, y entonces
   * el que manda lo decide `SET locale` de Config.wtf, no nosotros. Escribir en
   * la carpeta equivocada deja al jugador mirando la lista de reinos de otro
   * servidor sin ninguna pista de por qué.
   */
  async applyRealmlist(
    dir: string,
    host: string,
    preferred?: string | null
  ): Promise<{ written: string[]; locale: string }> {
    const presentes = await this.listLocales(dir);
    const objetivo = presentes.length
      ? presentes
      : [(await this.detectLocale(dir, preferred)) ?? preferred ?? 'esMX'];

    const written: string[] = [];
    for (const loc of objetivo) {
      const target = join(dir, 'Data', loc, 'realmlist.wtf');
      await mkdir(join(dir, 'Data', loc), { recursive: true });
      await writeFile(target, `set realmlist ${host}\r\n`, 'utf8');
      written.push(target);
    }

    const principal =
      (preferred && objetivo.includes(preferred) ? preferred : null) ?? objetivo[0];
    return { written, locale: principal };
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
    // Si la carpeta aún no existe, la unidad sí: se sube por el árbol hasta
    // encontrar algo que el sistema sepa medir.
    let actual = resolve(dir);
    for (let i = 0; i < 12; i++) {
      try {
        const fs = await statfs(actual);
        return fs.bavail * fs.bsize;
      } catch {
        const padre = resolve(actual, '..');
        if (padre === actual) break;
        actual = padre;
      }
    }
    return -1;
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

function gib(n: number): string {
  return `${(n / 1073741824).toFixed(1)} GB`;
}

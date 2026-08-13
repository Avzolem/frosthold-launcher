import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * Dos ajustes opcionales del cliente. Los dos se aplican a archivos que NO son
 * nuestros —el ejecutable del juego y su carpeta—, así que los dos hacen copia
 * antes de tocar nada y los dos se deshacen desde la misma casilla.
 */

/* ── Memoria ampliada (Large Address Aware) ─────────────────────────────── */

/**
 * El cliente de 3.3.5a es de 32 bits y arranca limitado a 2 GB de memoria
 * aunque el equipo tenga 32. Windows le dará hasta 4 GB si el ejecutable lleva
 * levantada una bandera de su cabecera, y eso es todo lo que hace esto:
 * cambiar un bit. No inyecta código ni añade archivos.
 *
 * Dónde vive ese bit, en la cabecera PE:
 *   0x3C                  → posición de la cabecera PE (`e_lfanew`)
 *   e_lfanew              → firma "PE\0\0"
 *   e_lfanew + 4          → arquitectura (0x014C = 32 bits)
 *   e_lfanew + 4 + 18     → `Characteristics`, y ahí el bit 0x0020
 *
 * Lo que SÍ rompe: la firma digital de Blizzard, porque cambia un byte del
 * archivo. Es inevitable y no afecta a poder jugar; el cliente de un reino
 * privado ya viene renombrado de todas formas.
 */

const LAA_BIT = 0x0020;
const MAQUINA_32 = 0x014c;

export interface EstadoLaa {
  /** El archivo es un ejecutable de 32 bits sobre el que esto tiene sentido. */
  aplicable: boolean;
  activo: boolean;
  /** En lenguaje llano, por si no es aplicable. */
  motivo?: string;
}

async function posicionDeLaBandera(buf: Buffer): Promise<number | null> {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const pe = buf.readUInt32LE(0x3c);
  if (pe <= 0 || pe + 24 > buf.length) return null;
  if (buf.readUInt32LE(pe) !== 0x00004550) return null; // 'PE\0\0'
  return pe + 22;
}

export async function leerLaa(exe: string): Promise<EstadoLaa> {
  let buf: Buffer;
  try {
    buf = await readFile(exe);
  } catch {
    return { aplicable: false, activo: false, motivo: 'No se encontró el ejecutable del juego.' };
  }

  const pos = await posicionDeLaBandera(buf);
  if (pos === null) {
    return { aplicable: false, activo: false, motivo: 'El ejecutable no tiene el formato esperado.' };
  }

  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt16LE(pe + 4) !== MAQUINA_32) {
    // Un cliente de 64 bits ya usa toda la memoria que quiere.
    return { aplicable: false, activo: true, motivo: 'El ejecutable ya es de 64 bits: no le hace falta.' };
  }

  return { aplicable: true, activo: (buf.readUInt16LE(pos) & LAA_BIT) !== 0 };
}

export async function aplicarLaa(
  exe: string,
  activar: boolean,
  carpeta: string,
  /** Huella que el manifiesto espera para este ejecutable, si se conoce. */
  huellaDelManifiesto?: string
): Promise<EstadoLaa> {
  const buf = await readFile(exe);
  const pos = await posicionDeLaBandera(buf);
  if (pos === null) throw new Error('El ejecutable no tiene el formato esperado.');

  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt16LE(pe + 4) !== MAQUINA_32) {
    throw new Error('El ejecutable no es de 32 bits: este ajuste no le aplica.');
  }

  // La copia se guarda UNA vez, la primera. Si se guardara en cada cambio, al
  // segundo clic la «copia original» ya sería la versión modificada y no habría
  // vuelta atrás.
  const respaldo = join(carpeta, '.frosthold', 'backups', 'exe-original.bin');
  await mkdir(join(carpeta, '.frosthold', 'backups'), { recursive: true });
  if (!(await existe(respaldo))) await copyFile(exe, respaldo);

  const antes = buf.readUInt16LE(pos);
  const despues = activar ? antes | LAA_BIT : antes & ~LAA_BIT;
  if (antes !== despues) {
    buf.writeUInt16LE(despues, pos);
    // No se recalcula la suma de comprobación de la cabecera: Windows no la
    // mira en programas de usuario, y dejarla como estaba conserva la pista de
    // que el archivo se tocó.
    await writeFile(exe, buf);
  }

  // El apunte va DESPUÉS de escribir, con la huella real que quedó. Al apagar
  // la bandera el archivo vuelve a ser el del manifiesto, así que el apunte se
  // borra en vez de quedarse mintiendo.
  const relativa = exe.slice(carpeta.length).replace(/^[\\/]+/, '');
  if (activar && huellaDelManifiesto) {
    await anotarPatch(carpeta, relativa, {
      sha256: await huellaDe(exe),
      base: huellaDelManifiesto,
    });
  } else {
    await anotarPatch(carpeta, relativa, null);
  }

  return { aplicable: true, activo: activar };
}

/* ── Renderizado por Vulkan (DXVK) ──────────────────────────────────────── */

/**
 * DXVK traduce Direct3D 9 a Vulkan. En clientes viejos suele dar más
 * estabilidad, sobre todo junto a la memoria ampliada.
 *
 * AVISO QUE NO HAY QUE ENTERRAR: DXVK está hecho para Linux con Wine. Que
 * funcione en Windows es un uso derivado que el proyecto ni documenta ni
 * respalda, y no publica requisitos mínimos de tarjeta gráfica. Con una GPU o
 * un controlador antiguos, el juego simplemente no abrirá — por eso esto se
 * quita con el mismo clic con el que se pone.
 *
 * Se instala poniendo su `d3d9.dll` junto al ejecutable: Windows carga la del
 * directorio del programa antes que la del sistema.
 */

const DXVK_REPO = 'doitsujin/dxvk';
const MARCA = '.frosthold/dxvk.json';

export interface EstadoDxvk {
  instalado: boolean;
  version: string | null;
  /** Hay un d3d9.dll que no pusimos nosotros. No se toca. */
  ajeno: boolean;
}

export async function leerDxvk(carpeta: string): Promise<EstadoDxvk> {
  const dll = join(carpeta, 'd3d9.dll');
  if (!(await existe(dll))) return { instalado: false, version: null, ajeno: false };

  try {
    const marca = JSON.parse(await readFile(join(carpeta, MARCA), 'utf8')) as {
      version: string;
      sha256: string;
    };
    // Se compara la huella, no solo la existencia de la marca: si alguien
    // sustituyó la DLL a mano, es suya y no la vamos a borrar.
    const suma = createHash('sha256').update(await readFile(dll)).digest('hex');
    if (suma !== marca.sha256) return { instalado: false, version: null, ajeno: true };
    return { instalado: true, version: marca.version, ajeno: false };
  } catch {
    return { instalado: false, version: null, ajeno: true };
  }
}

/** La versión publicada más reciente, o null si no se puede preguntar. */
export async function ultimaVersionDxvk(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${DXVK_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { tag_name?: string };
    return j.tag_name?.replace(/^v/, '') ?? null;
  } catch {
    return null;
  }
}

export async function instalarDxvk(carpeta: string): Promise<EstadoDxvk> {
  const estado = await leerDxvk(carpeta);
  if (estado.ajeno) {
    throw new Error(
      'Ya hay un d3d9.dll en la carpeta del juego que no puso este launcher. ' +
        'Quítalo tú si quieres usar el nuestro: no vamos a borrar un archivo que no es nuestro.'
    );
  }

  const version = await ultimaVersionDxvk();
  if (!version) throw new Error('No se pudo consultar la versión de DXVK. ¿Hay conexión?');

  const url = `https://github.com/${DXVK_REPO}/releases/download/v${version}/dxvk-${version}.tar.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar DXVK (respondió ${res.status}).`);

  const dll = extraerDeTarGz(Buffer.from(await res.arrayBuffer()), `x32/d3d9.dll`);
  if (!dll) throw new Error('El paquete de DXVK no traía la versión de 32 bits que necesita el juego.');

  await writeFile(join(carpeta, 'd3d9.dll'), dll);
  await mkdir(join(carpeta, '.frosthold'), { recursive: true });
  await writeFile(
    join(carpeta, MARCA),
    JSON.stringify(
      { version, sha256: createHash('sha256').update(dll).digest('hex'), at: new Date().toISOString() },
      null,
      2
    )
  );

  return { instalado: true, version, ajeno: false };
}

export async function quitarDxvk(carpeta: string): Promise<EstadoDxvk> {
  const estado = await leerDxvk(carpeta);
  if (estado.ajeno) {
    throw new Error('Ese d3d9.dll no lo puso este launcher, así que no se toca.');
  }
  await rm(join(carpeta, 'd3d9.dll'), { force: true });
  await rm(join(carpeta, MARCA), { force: true });
  return { instalado: false, version: null, ajeno: false };
}

/**
 * Saca UN archivo de un .tar.gz. Se escribe a mano porque es medio centenar de
 * líneas y la alternativa es arrastrar una dependencia entera al proceso
 * principal para leer una cabecera de 512 bytes.
 */
export function extraerDeTarGz(gz: Buffer, sufijo: string): Buffer | null {
  const tar = gunzipSync(gz);
  let pos = 0;

  while (pos + 512 <= tar.length) {
    const nombre = tar.toString('utf8', pos, pos + 100).replace(/\0.*$/, '');
    if (!nombre) {
      pos += 512;
      continue;
    }

    // El tamaño va en octal, en texto, y puede venir rellenado con espacios.
    const tamano = parseInt(tar.toString('utf8', pos + 124, pos + 136).replace(/[\0 ]/g, ''), 8) || 0;
    const datos = pos + 512;

    if (nombre.endsWith(sufijo)) return tar.subarray(datos, datos + tamano);

    // Cada archivo ocupa un múltiplo de 512.
    pos = datos + Math.ceil(tamano / 512) * 512;
  }

  return null;
}

async function existe(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Tamaño del ejecutable, solo para informar en la interfaz. */
export async function tamanoDe(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

/* ── Registro de lo que modificamos a propósito ─────────────────────────── */

/**
 * La bandera de memoria ampliada cambia un byte del ejecutable, y con él su
 * huella. El verificador compara contra el manifiesto, así que ese archivo
 * pasaba a estar «dañado»: el launcher lo volvía a bajar y al bajarlo borraba
 * la bandera. Activar, descargar, perderla, repetir.
 *
 * Es el mismo fallo que el README describe para el realmlist —un archivo que
 * nosotros reescribimos no puede verificarse contra el manifiesto— y aquí se
 * resuelve igual de explícito: se apunta qué archivo tocamos, con qué huella
 * quedó, y sobre qué huella de manifiesto se hizo.
 *
 * `base` es lo que impide que esto se convierta en un agujero: si algún día el
 * cliente se actualiza de verdad, la huella esperada cambia, el apunte deja de
 * casar y el archivo se vuelve a bajar como debe. La bandera se pierde en esa
 * actualización, que es correcto: es un ejecutable nuevo.
 */
export interface ApuntePatch {
  /** Huella que TIENE el archivo después de que lo tocáramos. */
  sha256: string;
  /** Huella que el manifiesto esperaba cuando se aplicó. */
  base: string;
}

const PATCH_FILE = '.frosthold/patched.json';

export async function leerPatched(carpeta: string): Promise<Record<string, ApuntePatch>> {
  try {
    return JSON.parse(await readFile(join(carpeta, PATCH_FILE), 'utf8'));
  } catch {
    return {};
  }
}

async function escribirPatched(carpeta: string, datos: Record<string, ApuntePatch>) {
  await mkdir(join(carpeta, '.frosthold'), { recursive: true });
  await writeFile(join(carpeta, PATCH_FILE), JSON.stringify(datos, null, 2));
}

/** Apunta que un archivo quedó modificado por nosotros, o borra el apunte. */
export async function anotarPatch(
  carpeta: string,
  rutaRelativa: string,
  apunte: ApuntePatch | null
): Promise<void> {
  const datos = await leerPatched(carpeta);
  if (apunte) datos[rutaRelativa] = apunte;
  else delete datos[rutaRelativa];
  await escribirPatched(carpeta, datos);
}

export async function huellaDe(p: string): Promise<string> {
  return createHash('sha256').update(await readFile(p)).digest('hex');
}

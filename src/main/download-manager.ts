import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  diskMessage,
  fetchWithHeaderTimeout,
  httpMessage,
  isFatalWriteError,
  networkMessage,
} from './net-errors';
import type {
  DownloadProgress,
  InstalledRecord,
  Manifest,
  ManifestFile,
} from '../shared/types';

const RETRIES = 4;
const CONCURRENCY = 4;
const PROGRESS_MS = 250;
/** Ventana de la media móvil de velocidad. Menos que esto y el número baila. */
const SPEED_WINDOW_MS = 5000;
/** Tiempo máximo hasta que el servidor manda las cabeceras. */
const HEADER_TIMEOUT_MS = 30_000;
/** Sin un solo byte durante este rato, la conexión está muerta aunque nadie lo diga. */
const STALL_MS = 90_000;
/** Cada cuánto se mira si la descarga sigue viva. */
const STALL_CHECK_MS = 5000;

/**
 * Un fallo del que no se sale reintentando: disco lleno, carpeta sin permisos.
 * Corta la descarga entera en vez de repetir cuatro intentos por cada uno de
 * los archivos que quedan.
 */
export class FatalDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalDownloadError';
  }
}

export class DownloadManager extends EventEmitter {
  private abort: AbortController | null = null;
  private fatal: FatalDownloadError | null = null;
  private installDir = '';
  private record: InstalledRecord = {};
  private bytesDone = 0;
  private bytesTotal = 0;
  private filesDone = 0;
  private filesTotal = 0;
  private inFlight = new Set<string>();
  /** Bytes que cada archivo aporta ahora mismo al total. Ver `setContributed`. */
  private contributed = new Map<string, number>();
  private samples: Array<{ t: number; bytes: number }> = [];
  private ticker: NodeJS.Timeout | null = null;

  setInstallDir(dir: string) {
    this.installDir = dir;
  }

  getInstallDir(): string {
    return this.installDir;
  }

  async fetchManifest(url: string): Promise<Manifest> {
    let res: Response;
    try {
      res = await fetchWithHeaderTimeout(url, {}, HEADER_TIMEOUT_MS);
    } catch (err) {
      // Aquí se separa «no tienes internet» de «el servidor no responde». Antes
      // los dos llegaban a la pantalla como «fetch failed».
      throw new Error(networkMessage(err, 'descargar la lista de archivos del cliente'));
    }

    if (!res.ok) {
      throw new Error(httpMessage(res.status, 'descargar la lista de archivos del cliente'));
    }

    let m: Manifest;
    try {
      m = (await res.json()) as Manifest;
    } catch {
      throw new Error(
        'La lista de archivos del cliente llegó dañada o incompleta. Vuelve a intentarlo en un momento.'
      );
    }

    if (!Array.isArray(m.files) || !m.files.length) {
      throw new Error('La lista de archivos del cliente llegó vacía.');
    }
    for (const f of m.files) {
      if (!f?.path || typeof f.size !== 'number' || !f.sha256 || !f.url) {
        throw new Error('La lista de archivos del cliente tiene entradas incompletas.');
      }
    }
    return m;
  }

  // ─── Registro de lo instalado ──────────────────────────────────────────────
  // Rehashear 16 GB tarda minutos. Guardamos tamaño y fecha de cada archivo ya
  // verificado; si ninguno de los dos cambió, lo damos por bueno. La
  // verificación por hash completo queda para "Reparar", que es explícito.

  private recordPath() {
    return join(this.installDir, '.frosthold', 'installed.json');
  }

  private async loadRecord() {
    try {
      this.record = JSON.parse(await readFile(this.recordPath(), 'utf8'));
    } catch {
      this.record = {};
    }
  }

  private async saveRecord() {
    try {
      const p = this.recordPath();
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(this.record));
    } catch (err) {
      // Perder el registro cuesta una verificación larga la próxima vez, no la
      // instalación. No es motivo para tumbar una descarga de 16 GB, pero sí
      // para que se sepa.
      this.emit('warning', {
        message:
          'No se pudo guardar el registro de archivos verificados; la próxima comprobación tardará más.',
        detail: (err as Error).message,
      });
    }
  }

  /** Qué falta por bajar. `deep` fuerza hash completo de todo lo que ya existe. */
  async plan(manifest: Manifest, deep = false): Promise<ManifestFile[]> {
    if (!this.installDir) throw new Error('Falta elegir la carpeta del juego.');
    await this.loadRecord();
    const missing: ManifestFile[] = [];
    let checked = 0;
    const total = manifest.files.length;
    // El contador se emitía solo cuando tocaba rehashear, así que en el caso
    // normal —todo verificado— no se emitía nunca y la interfaz se quedaba
    // clavada en «Comprobando qué falta…». Ahora avanza siempre.
    // Se emite por tiempo y no por cada archivo: 141 avisos seguidos marean a
    // la interfaz y, sobre todo, a un lector de pantalla.
    let ultimoAviso = 0;
    const tick = () => {
      checked++;
      const ahora = Date.now();
      if (checked === total || ahora - ultimoAviso > 400) {
        ultimoAviso = ahora;
        this.emit('check-progress', { checked, total });
      }
    };

    for (const f of manifest.files) {
      const abs = join(this.installDir, f.path);
      let st;
      try {
        st = await stat(abs);
      } catch {
        missing.push(f);
        tick();
        continue;
      }

      if (st.size !== f.size) {
        missing.push(f);
        tick();
        continue;
      }

      const known = this.record[f.path];
      const unchanged = known && known.size === st.size && known.mtimeMs === st.mtimeMs;

      if (!deep && unchanged && known.sha256 === f.sha256) {
        tick();
        continue;
      }

      const hash = await this.hashFile(abs);
      if (hash !== f.sha256) {
        missing.push(f);
      } else {
        this.record[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: hash };
      }
      tick();
    }

    await this.saveRecord();
    return missing;
  }

  /** Lo que ocupa en disco lo ya descargado a medias de esta lista. */
  async partialBytes(files: ManifestFile[]): Promise<number> {
    let n = 0;
    for (const f of files) n += await this.partialSize(join(this.installDir, f.path));
    return n;
  }

  // ─── Descarga ──────────────────────────────────────────────────────────────

  async start(files: ManifestFile[]) {
    if (this.abort) throw new Error('Ya hay una descarga en curso');
    const abort = new AbortController();
    this.abort = abort;
    this.fatal = null;

    this.filesTotal = files.length;
    this.filesDone = 0;
    this.bytesTotal = files.reduce((n, f) => n + f.size, 0);
    this.bytesDone = 0;
    this.samples = [];
    this.inFlight.clear();
    this.contributed.clear();

    // Los .part de una sesión anterior ya ocupan disco: cuentan como avance.
    for (const f of files) {
      this.setContributed(f.path, await this.partialSize(join(this.installDir, f.path)));
    }

    this.ticker = setInterval(() => this.emitProgress(), PROGRESS_MS);
    this.emit('phase', 'downloading');

    const queue = [...files];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
      this.worker(queue, abort)
    );

    // `Promise.all` devolvía el control en cuanto uno fallaba, con los otros
    // tres todavía escribiendo. Como acto seguido se ponía `abort = null`, una
    // segunda pulsación de «Descargar» arrancaba un juego nuevo de trabajadores
    // sobre los mismos .part: dos flujos anexando al mismo archivo. Aquí se
    // espera a que todos terminen de verdad antes de soltar el candado.
    const results = await Promise.allSettled(workers);

    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.emitProgress();
    await this.saveRecord();
    const abortado = abort.signal.aborted;
    const fatal = this.fatal;
    this.abort = null;
    this.fatal = null;

    const fallo = results.find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;

    if (fatal) {
      this.emit('phase', 'error');
      throw fatal;
    }
    if (abortado) {
      this.emit('phase', 'idle');
      return;
    }
    if (fallo) {
      this.emit('phase', 'error');
      throw fallo.reason;
    }
    this.emit('phase', 'ready');
  }

  /** Hay una descarga del cliente en curso. */
  isRunning(): boolean {
    return this.abort !== null;
  }

  stop() {
    this.abort?.abort();
  }

  private async worker(queue: ManifestFile[], abort: AbortController) {
    for (;;) {
      // Un fallo fatal en otro trabajador (disco lleno) para a todos: seguir
      // pidiendo archivos solo sirve para acumular errores idénticos.
      if (abort.signal.aborted || this.fatal) return;
      const f = queue.shift();
      if (!f) return;
      await this.downloadWithRetries(f, abort);
      this.filesDone++;
    }
  }

  private async downloadWithRetries(f: ManifestFile, abort: AbortController) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      // El avance de este archivo es exactamente lo que hay en disco. Sin este
      // ajuste, los bytes que se transmitieron pero no llegaron a escribirse
      // antes de un corte quedaban contados para siempre y la barra terminaba
      // por encima del 100%.
      this.setContributed(f.path, await this.partialSize(join(this.installDir, f.path)));

      try {
        await this.downloadOne(f, abort);
        this.setContributed(f.path, f.size);
        return;
      } catch (err) {
        if (abort.signal.aborted) throw err;

        if (isFatalWriteError(err)) {
          const msg =
            diskMessage(err, this.installDir) ??
            `No se pudo escribir en la carpeta del juego: ${(err as Error).message}`;
          this.fatal = new FatalDownloadError(msg);
          abort.abort();
          throw this.fatal;
        }

        lastError = err;
        this.emit('retry', { path: f.path, attempt, error: (err as Error).message });
        if (attempt < RETRIES) {
          // Espera creciente: 1s, 2s, 4s. Si el servidor está saturado,
          // insistir de inmediato solo empeora las cosas.
          await this.wait(1000 * 2 ** (attempt - 1), abort.signal);
        }
      }
    }
    throw new Error(
      `${networkMessage(lastError, `descargar ${f.path}`)} (se intentó ${RETRIES} veces)`
    );
  }

  private async downloadOne(f: ManifestFile, abort: AbortController) {
    const dest = join(this.installDir, f.path);
    const part = `${dest}.part`;
    await mkdir(dirname(dest), { recursive: true });

    let from = await this.partialSize(dest);
    if (from > f.size) {
      // El .part es más grande que el archivo final: quedó de una versión
      // anterior del manifiesto. No sirve.
      await rm(part, { force: true });
      from = 0;
      this.setContributed(f.path, 0);
    }

    const headers: Record<string, string> = {};
    if (from > 0) headers['Range'] = `bytes=${from}-`;

    // Un control propio por intento: así el vigía de parones puede cortar esta
    // descarga sin tumbar las otras tres ni cancelar la sesión entera.
    const intento = new AbortController();
    const propagar = () => intento.abort(abort.signal.reason);
    if (abort.signal.aborted) intento.abort(abort.signal.reason);
    else abort.signal.addEventListener('abort', propagar);

    let parada = false;
    let ultimoDato = Date.now();
    const vigia = setInterval(() => {
      if (Date.now() - ultimoDato > STALL_MS) {
        parada = true;
        intento.abort();
      }
    }, STALL_CHECK_MS);

    const cerrarVigilancia = () => {
      clearInterval(vigia);
      abort.signal.removeEventListener('abort', propagar);
    };

    try {
      const res = await fetchWithHeaderTimeout(
        f.url,
        { headers, signal: intento.signal },
        HEADER_TIMEOUT_MS
      );

      // 416: el servidor dice que el rango pedido no existe. Casi siempre es un
      // .part sobrante de otra versión del archivo. Reintentar el mismo rango
      // cuatro veces no lo arregla nunca; tirarlo, sí.
      if (res.status === 416) {
        await rm(part, { force: true });
        this.setContributed(f.path, 0);
        throw new Error('el trozo a medias ya no vale; se vuelve a empezar el archivo');
      }
      if (!res.ok) throw new Error(httpMessage(res.status, `descargar ${f.path}`));
      if (!res.body) throw new Error('el servidor respondió sin contenido');

      // Pedimos un rango pero nos mandan el archivo entero: hay que reescribir
      // desde cero, no anexar, o el archivo queda con el principio duplicado.
      const resuming = from > 0 && res.status === 206;
      if (from > 0 && !resuming) {
        this.setContributed(f.path, 0);
        from = 0;
      }

      this.inFlight.add(f.path);
      const hash = createHash('sha256');

      // El hash tiene que cubrir el archivo completo, así que al reanudar hay
      // que volver a leer del disco lo ya descargado.
      if (resuming) {
        await this.hashInto(hash, part, from);
        this.emit('resume', { path: f.path, from, size: f.size });
      }

      const out = createWriteStream(part, { flags: resuming ? 'a' : 'w' });
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

      let enEsteIntento = from;
      source.on('data', (chunk: Buffer) => {
        ultimoDato = Date.now();
        hash.update(chunk);
        enEsteIntento += chunk.length;
        this.setContributed(f.path, enEsteIntento);
        this.samples.push({ t: Date.now(), bytes: chunk.length });
      });

      try {
        // La señal va aquí y no solo en el `fetch`: abortar la petición después
        // de que lleguen las cabeceras NO corta el cuerpo que ya está viniendo.
        // Sin esto, pulsar «Detener» dejaba el archivo bajando hasta el final;
        // en un MPQ de 2 GB eso son minutos de descarga que nadie pidió, y el
        // vigía de parones no servía para nada.
        await pipeline(source, out, { signal: intento.signal });
      } catch (err) {
        if (parada) {
          throw new Error('la descarga se quedó parada sin recibir datos');
        }
        throw err;
      } finally {
        this.inFlight.delete(f.path);
      }

      const digest = hash.digest('hex');
      if (digest !== f.sha256) {
        await rm(part, { force: true });
        // El progreso de este archivo no valía nada.
        this.setContributed(f.path, 0);
        throw new Error('el contenido no coincide con la lista de archivos');
      }

      await rename(part, dest);
      const st = await stat(dest);
      this.record[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: digest };
    } finally {
      cerrarVigilancia();
    }
  }

  // ─── Utilidades ────────────────────────────────────────────────────────────

  /**
   * Fija cuántos bytes aporta un archivo al total y corrige la suma. Llevar la
   * cuenta por archivo, en vez de ir sumando trozos sueltos, es lo que permite
   * que un reintento no cuente dos veces lo mismo.
   */
  private setContributed(path: string, bytes: number) {
    const antes = this.contributed.get(path) ?? 0;
    this.contributed.set(path, bytes);
    this.bytesDone += bytes - antes;
    if (this.bytesDone < 0) this.bytesDone = 0;
  }

  /** Espera que se puede interrumpir: detener no debe tardar 4 segundos. */
  private wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const fin = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', fin);
        resolve();
      };
      const timer = setTimeout(fin, ms);
      signal.addEventListener('abort', fin);
    });
  }

  private async partialSize(dest: string): Promise<number> {
    try {
      return (await stat(`${dest}.part`)).size;
    } catch {
      return 0;
    }
  }

  private hashFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(path)
        .on('data', (c) => h.update(c))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', reject);
    });
  }

  private hashInto(hash: ReturnType<typeof createHash>, path: string, bytes: number) {
    return new Promise<void>((resolve, reject) => {
      createReadStream(path, { start: 0, end: bytes - 1 })
        .on('data', (c) => hash.update(c))
        .on('end', () => resolve())
        .on('error', reject);
    });
  }

  private emitProgress() {
    const now = Date.now();
    this.samples = this.samples.filter((s) => now - s.t < SPEED_WINDOW_MS);
    const windowBytes = this.samples.reduce((n, s) => n + s.bytes, 0);
    const windowMs = this.samples.length
      ? Math.max(now - this.samples[0].t, 1)
      : 0;
    const speed = windowMs > 0 ? (windowBytes / windowMs) * 1000 : 0;
    const remaining = Math.max(this.bytesTotal - this.bytesDone, 0);

    const progress: DownloadProgress = {
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
      // Sin recortar a `bytesTotal` a propósito: si la cuenta se descuadra,
      // queremos verlo y que las pruebas lo caigan, no taparlo con un mínimo.
      bytesDone: this.bytesDone,
      bytesTotal: this.bytesTotal,
      speed,
      etaSeconds: speed > 1024 ? Math.round(remaining / speed) : null,
      current: [...this.inFlight],
    };
    this.emit('progress', progress);
  }
}

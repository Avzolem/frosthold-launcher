import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
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

export class DownloadManager extends EventEmitter {
  private abort: AbortController | null = null;
  private installDir = '';
  private record: InstalledRecord = {};
  private bytesDone = 0;
  private bytesTotal = 0;
  private filesDone = 0;
  private filesTotal = 0;
  private inFlight = new Set<string>();
  private samples: Array<{ t: number; bytes: number }> = [];
  private ticker: NodeJS.Timeout | null = null;

  setInstallDir(dir: string) {
    this.installDir = dir;
  }

  async fetchManifest(url: string): Promise<Manifest> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`El manifiesto respondió ${res.status}`);
    const m = (await res.json()) as Manifest;
    if (!Array.isArray(m.files) || !m.files.length) {
      throw new Error('El manifiesto no trae archivos');
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
    const p = this.recordPath();
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(this.record));
  }

  /** Qué falta por bajar. `deep` fuerza hash completo de todo lo que ya existe. */
  async plan(manifest: Manifest, deep = false): Promise<ManifestFile[]> {
    await this.loadRecord();
    const missing: ManifestFile[] = [];
    let checked = 0;

    for (const f of manifest.files) {
      const abs = join(this.installDir, f.path);
      let st;
      try {
        st = await stat(abs);
      } catch {
        missing.push(f);
        continue;
      }

      if (st.size !== f.size) {
        missing.push(f);
        continue;
      }

      const known = this.record[f.path];
      const unchanged = known && known.size === st.size && known.mtimeMs === st.mtimeMs;

      if (!deep && unchanged && known.sha256 === f.sha256) {
        continue;
      }

      const hash = await this.hashFile(abs);
      if (hash !== f.sha256) {
        missing.push(f);
      } else {
        this.record[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: hash };
      }

      this.emit('check-progress', { checked: ++checked, total: manifest.files.length });
    }

    await this.saveRecord();
    return missing;
  }

  // ─── Descarga ──────────────────────────────────────────────────────────────

  async start(files: ManifestFile[]) {
    if (this.abort) throw new Error('Ya hay una descarga en curso');
    this.abort = new AbortController();

    this.filesTotal = files.length;
    this.filesDone = 0;
    this.bytesTotal = files.reduce((n, f) => n + f.size, 0);
    this.bytesDone = 0;
    this.samples = [];
    this.inFlight.clear();

    // Los .part de una sesión anterior ya ocupan disco: cuentan como avance.
    for (const f of files) {
      this.bytesDone += await this.partialSize(join(this.installDir, f.path));
    }

    this.ticker = setInterval(() => this.emitProgress(), PROGRESS_MS);
    this.emit('phase', 'downloading');

    const queue = [...files];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
      this.worker(queue)
    );

    try {
      await Promise.all(workers);
      this.emit('phase', 'ready');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.emit('phase', 'idle');
      } else {
        this.emit('phase', 'error');
        throw err;
      }
    } finally {
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.emitProgress();
      await this.saveRecord();
      this.abort = null;
    }
  }

  /** Hay una descarga del cliente en curso. */
  isRunning(): boolean {
    return this.abort !== null;
  }

  stop() {
    this.abort?.abort();
  }

  private async worker(queue: ManifestFile[]) {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      await this.downloadWithRetries(f);
      this.filesDone++;
    }
  }

  private async downloadWithRetries(f: ManifestFile) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await this.downloadOne(f);
        return;
      } catch (err) {
        if (this.abort?.signal.aborted) throw err;
        lastError = err;
        this.emit('retry', { path: f.path, attempt, error: (err as Error).message });
        // Espera creciente: 1s, 2s, 4s. Si el CDN está saturado, insistir de
        // inmediato solo empeora las cosas.
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
    throw new Error(`No se pudo descargar ${f.path}: ${(lastError as Error)?.message}`);
  }

  private async downloadOne(f: ManifestFile) {
    const dest = join(this.installDir, f.path);
    const part = `${dest}.part`;
    await mkdir(dirname(dest), { recursive: true });

    let from = await this.partialSize(dest);
    if (from > f.size) {
      // El .part es más grande que el archivo final: quedó de una versión
      // anterior del manifiesto. No sirve.
      await rm(part, { force: true });
      from = 0;
    }

    const headers: Record<string, string> = {};
    if (from > 0) headers['Range'] = `bytes=${from}-`;

    const res = await fetch(f.url, {
      headers,
      redirect: 'follow',
      signal: this.abort!.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('respuesta sin cuerpo');

    // Pedimos un rango pero nos mandan el archivo entero: hay que reescribir
    // desde cero, no anexar, o el archivo queda con el principio duplicado.
    const resuming = from > 0 && res.status === 206;
    if (from > 0 && !resuming) {
      this.bytesDone -= from;
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

    source.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      this.bytesDone += chunk.length;
      this.samples.push({ t: Date.now(), bytes: chunk.length });
    });

    try {
      await pipeline(source, out);
    } finally {
      this.inFlight.delete(f.path);
    }

    const digest = hash.digest('hex');
    if (digest !== f.sha256) {
      await rm(part, { force: true });
      // El progreso de este archivo no valía nada.
      this.bytesDone -= f.size;
      throw new Error('el contenido no coincide con el manifiesto');
    }

    await rename(part, dest);
    const st = await stat(dest);
    this.record[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: digest };
  }

  // ─── Utilidades ────────────────────────────────────────────────────────────

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
      bytesDone: this.bytesDone,
      bytesTotal: this.bytesTotal,
      speed,
      etaSeconds: speed > 1024 ? Math.round(remaining / speed) : null,
      current: [...this.inFlight],
    };
    this.emit('progress', progress);
  }
}

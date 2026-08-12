#!/usr/bin/env node
// Los casos raros del motor de descargas, contra un servidor local que puede
// portarse mal a propósito. Son los que dejan a un jugador atascado y los que
// no se pueden provocar contra el CDN de verdad: rangos rechazados, servidores
// que ignoran el rango, conexiones que se caen a media descarga, disco que no
// admite escritura y detener a mitad para volver a empezar.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { DownloadManager } = require(join(ROOT, 'dist/main/download-manager.js'));

let fallos = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✓' : '✖'} ${msg}${extra ? `  ${extra}` : ''}`);
  if (!cond) fallos++;
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const shaDe = async (p) => sha(await readFile(p));

// ── Servidor de mentira ─────────────────────────────────────────────────────

const CUERPO = randomBytes(300_000);
const LENTO = randomBytes(600_000);
const golpes = new Map();
const contar = (k) => {
  const n = (golpes.get(k) ?? 0) + 1;
  golpes.set(k, n);
  return n;
};

const server = createServer(async (req, res) => {
  const ruta = req.url ?? '';
  const rango = req.headers.range;
  const desde = rango ? Number(/bytes=(\d+)-/.exec(rango)?.[1] ?? 0) : 0;
  const n = contar(ruta);

  // Rechaza cualquier petición por rango. Es lo que hace un servidor al que le
  // cambiaron el archivo debajo, y antes dejaba el archivo bloqueado para
  // siempre: cuatro intentos idénticos, los cuatro con 416.
  if (ruta.startsWith('/rechaza-rango')) {
    if (rango) {
      res.writeHead(416, { 'content-range': `bytes */${CUERPO.length}` });
      return res.end();
    }
    res.writeHead(200, { 'content-length': String(CUERPO.length) });
    return res.end(CUERPO);
  }

  // Ignora el rango y manda el archivo entero con un 200.
  if (ruta.startsWith('/ignora-rango')) {
    res.writeHead(200, { 'content-length': String(CUERPO.length) });
    return res.end(CUERPO);
  }

  // Se cae a mitad la primera vez y se porta bien a partir de la segunda.
  if (ruta.startsWith('/se-cae')) {
    if (n === 1) {
      res.writeHead(200, { 'content-length': String(CUERPO.length) });
      res.write(CUERPO.subarray(0, 100_000));
      return res.destroy();
    }
    const trozo = CUERPO.subarray(desde);
    res.writeHead(desde ? 206 : 200, {
      'content-length': String(trozo.length),
      ...(desde ? { 'content-range': `bytes ${desde}-${CUERPO.length - 1}/${CUERPO.length}` } : {}),
    });
    return res.end(trozo);
  }

  // Gotea, para poder detenerlo a mitad.
  if (ruta.startsWith('/lento')) {
    const trozo = LENTO.subarray(desde);
    res.writeHead(desde ? 206 : 200, {
      'content-length': String(trozo.length),
      ...(desde ? { 'content-range': `bytes ${desde}-${LENTO.length - 1}/${LENTO.length}` } : {}),
    });
    let i = 0;
    const paso = 20_000;
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(timer);
      res.write(trozo.subarray(i, i + paso));
      i += paso;
      if (i >= trozo.length) {
        clearInterval(timer);
        res.end();
      }
    }, 40);
    return;
  }

  // Normal, con soporte de rangos.
  const trozo = CUERPO.subarray(desde);
  res.writeHead(desde ? 206 : 200, {
    'content-length': String(trozo.length),
    ...(desde ? { 'content-range': `bytes ${desde}-${CUERPO.length - 1}/${CUERPO.length}` } : {}),
  });
  res.end(trozo);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const archivo = (path, ruta, buf = CUERPO) => ({
  path,
  size: buf.length,
  sha256: sha(buf),
  url: `${base}${ruta}`,
});

const dir = await mkdtemp(join(tmpdir(), 'frosthold-edge-'));
console.log(`\nCarpeta de prueba: ${dir}`);

// ── 1. El servidor rechaza el rango (416) ───────────────────────────────────
console.log('\n1. El servidor rechaza el rango pedido');
{
  const f = archivo('a/416.bin', '/rechaza-rango');
  await mkdir(join(dir, 'a'), { recursive: true });
  // Un .part sobrante de otra versión del archivo.
  await writeFile(join(dir, f.path) + '.part', randomBytes(50_000));

  const dm = new DownloadManager();
  dm.setInstallDir(dir);
  await dm.start([f]);

  ok((await shaDe(join(dir, f.path))) === f.sha256,
    'tira el trozo sobrante y baja el archivo entero en vez de bloquearse');
  ok(golpes.get('/rechaza-rango') === 2,
    'le bastan dos peticiones: el 416 y la buena', `${golpes.get('/rechaza-rango')} peticiones`);
}

// ── 2. El servidor ignora el rango y manda el archivo entero ────────────────
console.log('\n2. El servidor ignora el rango y manda todo');
{
  const f = archivo('b/entero.bin', '/ignora-rango');
  await mkdir(join(dir, 'b'), { recursive: true });
  await writeFile(join(dir, f.path) + '.part', CUERPO.subarray(0, 120_000));

  const dm = new DownloadManager();
  dm.setInstallDir(dir);
  await dm.start([f]);

  const st = await stat(join(dir, f.path));
  ok(st.size === f.size, 'el archivo no queda con el principio duplicado', `${st.size} B`);
  ok((await shaDe(join(dir, f.path))) === f.sha256, 'y el contenido es el correcto');
}

// ── 3. La conexión se cae a mitad ───────────────────────────────────────────
console.log('\n3. La conexión se cae a media descarga');
{
  const f = archivo('c/cortado.bin', '/se-cae');
  const dm = new DownloadManager();
  dm.setInstallDir(dir);
  let ultimo = null;
  let reintento = null;
  dm.on('progress', (p) => (ultimo = p));
  dm.on('retry', (r) => (reintento = r));
  await dm.start([f]);

  ok((await shaDe(join(dir, f.path))) === f.sha256, 'reintenta y termina con el archivo correcto');
  ok(reintento !== null, 'avisa del reintento en vez de callárselo');
  // La cuenta se llevaba sumando trozos sueltos: los bytes que se transmitieron
  // pero no llegaron al disco antes del corte quedaban contados para siempre y
  // la barra terminaba por encima del 100%.
  ok(ultimo && ultimo.bytesDone === ultimo.bytesTotal,
    'el progreso acaba exactamente en el total, ni un byte más',
    ultimo ? `${ultimo.bytesDone}/${ultimo.bytesTotal}` : 'sin progreso');
}

// ── 4. No se puede escribir: se corta y se explica ──────────────────────────
console.log('\n4. El disco no admite la escritura');
{
  // Un archivo donde debería haber una carpeta: mkdir falla igual que falla una
  // unidad llena o sin permisos, y por la misma vía.
  await writeFile(join(dir, 'bloqueado'), 'no soy una carpeta');
  const malo = archivo('bloqueado/x.bin', '/normal-1');
  const otro = archivo('d/otro.bin', '/normal-2');

  const dm = new DownloadManager();
  dm.setInstallDir(dir);
  let ultimo = null;
  let reintentos = 0;
  dm.on('progress', (p) => (ultimo = p));
  dm.on('retry', () => reintentos++);

  let error = null;
  const t0 = Date.now();
  try {
    await dm.start([malo, otro]);
  } catch (err) {
    error = err;
  }
  const tardo = Date.now() - t0;

  ok(error !== null && error.name === 'FatalDownloadError',
    'corta la descarga entera en vez de insistir archivo por archivo');
  ok(/carpeta|archivo|permiso|espacio/i.test(error?.message ?? ''),
    'el mensaje dice qué pasa con el disco', `«${(error?.message ?? '').slice(0, 70)}…»`);
  ok(reintentos === 0, 'no gasta cuatro intentos en un fallo que no se arregla solo',
    `${reintentos} reintentos`);
  ok(tardo < 3000, 'y falla enseguida, no a los siete segundos', `${tardo} ms`);
  ok(dm.isRunning() === false, 'suelta el candado de «hay una descarga en curso»');
  ok(ultimo && ultimo.current.length === 0,
    'y no deja ningún archivo a medio escribir cuando devuelve el control');
  await rm(join(dir, 'bloqueado'), { force: true });
}

// ── 5. Detener a mitad y volver a empezar ───────────────────────────────────
console.log('\n5. Detener a mitad y reanudar');
{
  const f = archivo('e/lento.bin', '/lento', LENTO);
  const dm = new DownloadManager();
  dm.setInstallDir(dir);

  const corriendo = dm.start([f]);
  await new Promise((r) => setTimeout(r, 350));
  dm.stop();
  await corriendo;

  ok(dm.isRunning() === false, 'después de detener, no queda ninguna descarga viva');
  const parcial = await stat(join(dir, f.path) + '.part').catch(() => null);
  ok(parcial !== null && parcial.size > 0 && parcial.size < f.size,
    'lo descargado se guarda a medias, no se tira',
    parcial ? `${parcial.size} de ${f.size} B` : 'sin .part');

  // Volver a arrancar acto seguido es justo lo que corrompía el archivo cuando
  // el candado se soltaba con trabajadores todavía escribiendo.
  await dm.start([f]);
  ok((await shaDe(join(dir, f.path))) === f.sha256,
    'al reanudar, el archivo queda íntegro y sin bytes duplicados');
}

// ── 6. La lista de archivos no se puede descargar ───────────────────────────
console.log('\n6. Fallos al pedir la lista de archivos');
{
  const dm = new DownloadManager();
  let sinRed = '';
  let servidorMal = '';
  try {
    await dm.fetchManifest('http://no-existe-este-dominio-frosthold.invalid/manifest.json');
  } catch (err) {
    sinRed = err.message;
  }
  try {
    await dm.fetchManifest(`${base}/lista-que-no-es-json`);
  } catch (err) {
    servidorMal = err.message;
  }
  ok(/conexión a internet/i.test(sinRed), 'sin internet lo dice con esas palabras',
    `«${sinRed.slice(0, 60)}…»`);
  ok(/dañada|incompleta|vacía|entradas/i.test(servidorMal),
    'una respuesta que no es la lista se distingue de un problema de red',
    `«${servidorMal.slice(0, 60)}…»`);
  ok(sinRed !== servidorMal, 'los dos fallos no comparten mensaje');
  ok(!/fetch failed/i.test(sinRed), 'y ninguno enseña el «fetch failed» de Node');
}

// ── 7. Plan: el contador avanza siempre ─────────────────────────────────────
console.log('\n7. Comprobación de lo ya instalado');
{
  const f = archivo('f/uno.bin', '/normal-3');
  const dm = new DownloadManager();
  dm.setInstallDir(dir);
  await dm.start([f]);

  const vistos = [];
  dm.on('check-progress', (c) => vistos.push(c));
  const pendientes = await dm.plan({ files: [f] }, false);
  ok(pendientes.length === 0, 'no vuelve a bajar lo que ya está verificado');
  // Antes solo se emitía al rehashear, así que en el caso normal —todo en su
  // sitio— la interfaz se quedaba clavada en «Comprobando qué falta…».
  ok(vistos.length > 0 && vistos.at(-1).checked === vistos.at(-1).total,
    'el contador de verificación llega al final aunque no haya que rehashear nada');

  const profundo = await dm.plan({ files: [f] }, true);
  ok(profundo.length === 0, 'la verificación profunda tampoco encuentra nada roto');
}

// ── Cierre ──────────────────────────────────────────────────────────────────
server.close();
await rm(dir, { recursive: true, force: true });
console.log(fallos ? `\n${fallos} FALLOS\n` : '\nTodas las comprobaciones pasan\n');
process.exit(fallos ? 1 : 0);

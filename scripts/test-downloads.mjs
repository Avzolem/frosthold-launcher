#!/usr/bin/env node
// Prueba el motor de descargas contra el CDN real con archivos pequeños.
// Cubre: descarga limpia, detección de corrupción, reanudación por rangos y
// el salto de archivos ya verificados.

import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { DownloadManager } = require(join(ROOT, 'dist/main/download-manager.js'));

const manifest = JSON.parse(
  await readFile(join(ROOT, 'dist-manifest/manifest.json'), 'utf8')
);

let passed = 0;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✖'} ${name}${extra ? `  ${extra}` : ''}`);
  ok ? passed++ : failed++;
};

const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');

// Archivos chicos de verdad, para no mover gigas en una prueba.
const small = manifest.files
  .filter((f) => f.size > 0 && f.size < 1_200_000)
  .sort((a, b) => a.size - b.size)
  .slice(0, 4);

const resumable = manifest.files
  .filter((f) => f.size > 400_000 && f.size < 1_200_000)
  .sort((a, b) => b.size - a.size)[0];

const dir = await mkdtemp(join(tmpdir(), 'frosthold-test-'));
console.log(`\nCarpeta de prueba: ${dir}`);
console.log(`Archivos: ${small.map((f) => f.path).join(', ')}\n`);

const dm = new DownloadManager();
dm.setInstallDir(dir);

// ── 1. Descarga limpia ──────────────────────────────────────────────────────
console.log('1. Descarga y verificación');
let lastProgress = null;
dm.on('progress', (p) => (lastProgress = p));

await dm.start(small);

for (const f of small) {
  const abs = join(dir, f.path);
  try {
    const st = await stat(abs);
    const hash = await sha(abs);
    check(f.path, st.size === f.size && hash === f.sha256, `${st.size} B`);
  } catch (err) {
    check(f.path, false, err.message);
  }
}
check(
  'el progreso llegó al total',
  lastProgress && lastProgress.bytesDone === lastProgress.bytesTotal,
  lastProgress ? `${lastProgress.bytesDone}/${lastProgress.bytesTotal}` : 'sin progreso'
);

// ── 2. plan() salta lo ya verificado ────────────────────────────────────────
console.log('\n2. Registro de lo instalado');
const planned = await dm.plan({ ...manifest, files: small }, false);
check('no vuelve a descargar lo que ya está', planned.length === 0, `${planned.length} pendientes`);

// ── 3. Detecta un archivo alterado ──────────────────────────────────────────
console.log('\n3. Detección de corrupción');
const victim = small[0];
await writeFile(join(dir, victim.path), Buffer.alloc(victim.size, 0x41));
const planned2 = await dm.plan({ ...manifest, files: small }, false);
check(
  'detecta el archivo alterado',
  planned2.length === 1 && planned2[0].path === victim.path,
  `${planned2.length} pendientes`
);

await dm.start(planned2);
check('lo vuelve a dejar bien', (await sha(join(dir, victim.path))) === victim.sha256);

// ── 4. Reanudación por rangos ───────────────────────────────────────────────
console.log('\n4. Reanudación de una descarga cortada');
const abs = join(dir, resumable.path);
await rm(abs, { force: true });

// Simulamos una descarga interrumpida: dejamos un .part con el primer tercio
// del archivo, tomado del propio CDN.
const third = Math.floor(resumable.size / 3);
const head = await fetch(resumable.url, { headers: { Range: `bytes=0-${third - 1}` } });
const headBuf = Buffer.from(await head.arrayBuffer());
check('el CDN acepta peticiones por rango', head.status === 206, `HTTP ${head.status}`);
await writeFile(`${abs}.part`, headBuf);

const dm2 = new DownloadManager();
dm2.setInstallDir(dir);
let resumeEvent = null;
dm2.on('resume', (r) => (resumeEvent = r));

await dm2.start([resumable]);

check(
  'el archivo reanudado es correcto',
  (await sha(abs)) === resumable.sha256,
  `${resumable.path} (${resumable.size} B)`
);
// Sin esto, la prueba anterior pasaría igual bajando el archivo entero otra
// vez: el hash sería correcto de todos modos y no nos enteraríamos.
check(
  'continuó desde el byte cortado en vez de empezar de cero',
  resumeEvent !== null && resumeEvent.from === headBuf.length,
  resumeEvent
    ? `continuó en ${resumeEvent.from} de ${resumable.size} (ahorró ${((resumeEvent.from / resumable.size) * 100).toFixed(0)}%)`
    : 'no hubo reanudación: se descargó entero'
);

// ── Cierre ──────────────────────────────────────────────────────────────────
await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} bien, ${failed} mal\n`);
process.exit(failed ? 1 : 0);

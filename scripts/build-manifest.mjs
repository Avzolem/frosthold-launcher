#!/usr/bin/env node
// Genera el manifiesto de Frosthold a partir del manifiesto de origen.
//
// Por qué no consumimos el de origen en vivo: si lo regeneran, el launcher
// cambiaría de comportamiento sin que nos enteremos. Este script se ejecuta
// a mano cuando el origen publica una versión nueva, se revisa el informe,
// y se publica el resultado. El launcher solo lee el nuestro.
//
//   node scripts/build-manifest.mjs            genera
//   node scripts/build-manifest.mjs --check    además verifica una muestra de URLs

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'frosthold.config.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'dist-manifest');
const EXTRA_DIR = join(ROOT, 'extra'); // archivos propios: parches, addons, configs
const CHECK = process.argv.includes('--check');

const { exclude, rename, brandTokens } = CONFIG.rules;
const excludeSet = new Set(exclude);

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function fetchUpstream() {
  const res = await fetch(CONFIG.upstream.manifestUrl, { redirect: 'follow' });
  if (!res.ok) fail(`el origen respondió ${res.status} ${res.statusText}`);
  return res.json();
}

// Archivos nuestros que se suman al cliente base. El hash se calcula aquí,
// nunca se declara a mano: un hash equivocado deja el launcher en un bucle
// de "descarga, verifica, falla, vuelve a descargar".
function collectExtras() {
  let files = [];
  try {
    statSync(EXTRA_DIR);
  } catch {
    return files;
  }
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = relative(EXTRA_DIR, abs).split('\\').join('/');
      const buf = readFileSync(abs);
      files.push({
        path: rel,
        size: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        url: `${CONFIG.manifestUrl.replace(/\/manifest\.json$/, '')}/extra/${rel}`,
        origin: 'frosthold',
      });
    }
  };
  walk(EXTRA_DIR);
  return files;
}

function transform(upstream) {
  if (!Array.isArray(upstream.files)) fail('el manifiesto de origen no trae lista de archivos');

  const kept = [];
  const dropped = [];
  const renamed = [];

  for (const f of upstream.files) {
    if (excludeSet.has(f.path)) {
      dropped.push(f.path);
      continue;
    }
    const newPath = rename[f.path];
    if (newPath) renamed.push(`${f.path} → ${newPath}`);
    kept.push({
      path: newPath || f.path,
      size: f.size,
      sha256: f.sha256,
      url: f.url,
      origin: 'upstream',
    });
  }

  const missingExclusions = exclude.filter((p) => !dropped.includes(p));
  if (missingExclusions.length) {
    fail(
      `estos archivos ya no existen en el origen y las reglas los esperaban:\n  ` +
        missingExclusions.join('\n  ') +
        `\nRevisa si el origen cambió antes de publicar.`
    );
  }

  const extras = collectExtras();
  const files = [...kept, ...extras].sort((a, b) => a.path.localeCompare(b.path));

  // Nada con marca ajena puede llegar al disco del jugador.
  const branded = files.filter((f) =>
    brandTokens.some((t) => f.path.toLowerCase().includes(t.toLowerCase()))
  );
  if (branded.length) {
    fail(
      `quedaron archivos con marca del origen en el manifiesto:\n  ` +
        branded.map((f) => f.path).join('\n  ') +
        `\nAñádelos a rules.exclude o a rules.rename.`
    );
  }

  // Que no haya dos entradas para la misma ruta: el orden de descarga no está
  // garantizado y ganaría cualquiera de las dos.
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.path)) fail(`ruta duplicada en el manifiesto: ${f.path}`);
    seen.add(f.path);
  }

  const totalSize = files.reduce((n, f) => n + f.size, 0);

  return {
    manifest: {
      schemaVersion: 1,
      realm: CONFIG.realmName,
      version: `${CONFIG.patch}-frosthold-${upstream.version ?? 'sin-version'}`,
      upstreamVersion: upstream.version ?? null,
      generated: new Date().toISOString(),
      gameDir: '/',
      executableName: CONFIG.executableName,
      clientLocale: CONFIG.clientLocale,
      realmlistHost: CONFIG.realmlistHost,
      totalFiles: files.length,
      totalSize,
      requiredFreeSpace: Math.ceil(totalSize * 1.1),
      files,
    },
    report: { dropped, renamed, extras: extras.map((e) => e.path), totalSize },
  };
}

async function checkSample(files) {
  // Una muestra: el ejecutable, el archivo más grande y dos al azar fijo.
  const bySize = [...files].sort((a, b) => b.size - a.size);
  const sample = [
    files.find((f) => f.path === CONFIG.executableName),
    bySize[0],
    files[Math.floor(files.length / 3)],
    files[Math.floor((files.length * 2) / 3)],
  ].filter(Boolean);

  console.log('\nComprobando URLs (muestra):');
  let bad = 0;
  for (const f of sample) {
    try {
      const res = await fetch(f.url, { method: 'HEAD', redirect: 'follow' });
      const len = Number(res.headers.get('content-length') ?? 0);
      const okSize = len === 0 || len === f.size;
      const ok = res.ok && okSize;
      if (!ok) bad++;
      console.log(
        `  ${ok ? '✓' : '✖'} ${res.status} ${f.path}` +
          (len && !okSize ? `  (el servidor dice ${len} y el manifiesto ${f.size})` : '')
      );
    } catch (e) {
      bad++;
      console.log(`  ✖ error de red  ${f.path}  ${e.message}`);
    }
  }
  if (bad) fail(`${bad} de ${sample.length} comprobaciones fallaron`);
}

const gib = (n) => (n / 1073741824).toFixed(2) + ' GB';

const upstream = await fetchUpstream();
const { manifest, report } = transform(upstream);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`\nManifiesto de ${manifest.realm} generado`);
console.log(`  origen        ${upstream.version ?? '?'}  (${upstream.files.length} archivos)`);
console.log(`  resultado     ${manifest.totalFiles} archivos · ${gib(manifest.totalSize)}`);
console.log(`  excluidos     ${report.dropped.join(', ') || '—'}`);
console.log(`  renombrados   ${report.renamed.join(', ') || '—'}`);
console.log(`  propios       ${report.extras.join(', ') || '—'}`);
console.log(`  escrito en    ${join(OUT_DIR, 'manifest.json')}`);

if (CHECK) await checkSample(manifest.files);
console.log();

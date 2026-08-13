#!/usr/bin/env node
// Los dos ajustes opcionales del cliente: la bandera de memoria ampliada, que
// cambia un bit del ejecutable del juego, y el empaquetado de DXVK. Ambos
// tocan archivos que no son nuestros, así que lo que se comprueba aquí es
// sobre todo que no rompan nada y que se puedan deshacer.

import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const t = require(join(ROOT, 'dist/main/client-tweaks.js'));

let fallos = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗ FALLO'} ${msg}`);
  if (!cond) fallos++;
};

/** Un PE mínimo pero legítimo: cabecera MZ, puntero, firma y COFF. */
function pe({ machine = 0x014c, characteristics = 0x0102, relleno = 4096 } = {}) {
  const buf = Buffer.alloc(relleno);
  buf.write('MZ', 0, 'latin1');
  const off = 0x80;
  buf.writeUInt32LE(off, 0x3c);
  buf.write('PE\0\0', off, 'latin1');
  buf.writeUInt16LE(machine, off + 4);
  buf.writeUInt16LE(characteristics, off + 22);
  // Un poco de cuerpo para poder comprobar que no se toca nada más.
  buf.fill(0xab, 0x400, relleno);
  return buf;
}

console.log('\n1. Memoria ampliada (Large Address Aware)');
const dir = await mkdtemp(join(tmpdir(), 'tweaks-'));
const exe = join(dir, 'Frosthold.exe');

await writeFile(exe, pe());
let e = await t.leerLaa(exe);
ok(e.aplicable === true && e.activo === false, 'reconoce un ejecutable de 32 bits sin la bandera');

const antes = await readFile(exe);
e = await t.aplicarLaa(exe, true, dir);
const despues = await readFile(exe);
ok(e.activo === true, 'la enciende');
ok((await t.leerLaa(exe)).activo === true, 'y al releer sigue encendida');

// Lo más importante de todo: que no haya tocado nada más que ese bit.
let distintos = 0;
for (let i = 0; i < antes.length; i++) if (antes[i] !== despues[i]) distintos++;
ok(distintos === 1, `cambia UN solo byte del ejecutable (cambió ${distintos})`);
ok(antes.length === despues.length, 'y no altera su tamaño');

ok(
  (await readFile(join(dir, '.frosthold', 'backups', 'exe-original.bin'))).equals(antes),
  'guarda copia del original antes de tocarlo'
);

await t.aplicarLaa(exe, false, dir);
ok((await t.leerLaa(exe)).activo === false, 'se puede apagar');
ok((await readFile(exe)).equals(antes), 'y apagándola el archivo vuelve a ser byte a byte el de partida');

// La copia se guarda UNA vez: si se rehiciera en cada cambio, tras encender y
// apagar la «copia original» sería ya una versión modificada.
await t.aplicarLaa(exe, true, dir);
ok(
  (await readFile(join(dir, '.frosthold', 'backups', 'exe-original.bin'))).equals(antes),
  'la copia sigue siendo la del primer día, no se rehace en cada cambio'
);

console.log('\n2. Ejecutables que no aplican');
const exe64 = join(dir, 'x64.exe');
await writeFile(exe64, pe({ machine: 0x8664 }));
e = await t.leerLaa(exe64);
ok(e.aplicable === false && /64 bits/.test(e.motivo ?? ''), 'un ejecutable de 64 bits se descarta con su razón');

const basura = join(dir, 'basura.exe');
await writeFile(basura, Buffer.alloc(2048, 7));
e = await t.leerLaa(basura);
ok(e.aplicable === false && !!e.motivo, 'un archivo que no es un ejecutable no revienta: se explica');

e = await t.leerLaa(join(dir, 'no-existe.exe'));
ok(e.aplicable === false && /encontr/i.test(e.motivo ?? ''), 'un ejecutable ausente tampoco revienta');

let tiro = false;
try {
  await t.aplicarLaa(exe64, true, dir);
} catch {
  tiro = true;
}
ok(tiro, 'y se niega a aplicarla sobre uno de 64 bits en vez de corromperlo');

console.log('\n3. Extraer del paquete de DXVK');
// Un .tar.gz de verdad, hecho a mano: cabeceras de 512 bytes, tamaño en octal.
function tar(archivos) {
  const bloques = [];
  for (const [nombre, contenido] of archivos) {
    const h = Buffer.alloc(512);
    h.write(nombre, 0, 'utf8');
    h.write(contenido.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
    h.write('0', 156, 'utf8');
    bloques.push(h, contenido, Buffer.alloc((512 - (contenido.length % 512)) % 512));
  }
  bloques.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(bloques));
}

const dll32 = Buffer.from('esta es la de 32 bits');
const paquete = tar([
  ['dxvk-9.9.9/x64/d3d9.dll', Buffer.from('la de 64, que NO sirve')],
  ['dxvk-9.9.9/x32/d3d11.dll', Buffer.from('otra api')],
  ['dxvk-9.9.9/x32/d3d9.dll', dll32],
]);

const sacada = t.extraerDeTarGz(paquete, 'x32/d3d9.dll');
ok(sacada !== null && sacada.equals(dll32), 'saca exactamente la DLL de 32 bits, no la de 64');
ok(t.extraerDeTarGz(paquete, 'x32/nada.dll') === null, 'y devuelve null si el archivo no está');

console.log('\n4. DXVK sobre la carpeta del juego');
const juego = await mkdtemp(join(tmpdir(), 'juego-'));
let d = await t.leerDxvk(juego);
ok(d.instalado === false && d.ajeno === false, 'una carpeta limpia no tiene nada instalado');

// Se simula una instalación nuestra escribiendo la marca como la escribe el
// código real, para poder comprobar el camino de quitarla sin salir a la red.
const nuestra = Buffer.from('dll nuestra');
await writeFile(join(juego, 'd3d9.dll'), nuestra);
await mkdir(join(juego, '.frosthold'), { recursive: true });
await writeFile(
  join(juego, '.frosthold', 'dxvk.json'),
  JSON.stringify({ version: '9.9.9', sha256: createHash('sha256').update(nuestra).digest('hex') })
);
d = await t.leerDxvk(juego);
ok(d.instalado === true && d.version === '9.9.9', 'reconoce la que puso el launcher, con su versión');

d = await t.quitarDxvk(juego);
ok(d.instalado === false, 'y la quita');

// EL CASO QUE IMPORTA: una DLL que no pusimos nosotros no se toca jamás.
const ajena = Buffer.from('la puso otro programa, o el propio jugador');
await writeFile(join(juego, 'd3d9.dll'), ajena);
d = await t.leerDxvk(juego);
ok(d.ajeno === true && d.instalado === false, 'una DLL ajena se detecta como ajena');

tiro = false;
try {
  await t.quitarDxvk(juego);
} catch {
  tiro = true;
}
ok(tiro, 'y se niega a borrarla');
ok((await readFile(join(juego, 'd3d9.dll'))).equals(ajena), 'la DLL ajena sigue intacta en el disco');

// Misma marca, contenido cambiado a mano: también es ajena.
await writeFile(
  join(juego, '.frosthold', 'dxvk.json'),
  JSON.stringify({ version: '9.9.9', sha256: createHash('sha256').update(nuestra).digest('hex') })
);
d = await t.leerDxvk(juego);
ok(d.ajeno === true, 'si la huella no cuadra con la marca, se trata como ajena');

console.log('\n5. La bandera NO puede disparar una redescarga');
// EL CASO QUE REPORTÓ EL USUARIO: activar la memoria ampliada cambia un byte
// del ejecutable, su huella deja de casar con el manifiesto, el verificador lo
// da por dañado y lo vuelve a bajar — y al bajarlo borra la bandera.
const juego2 = await mkdtemp(join(tmpdir(), 'plan-'));
const exe2 = join(juego2, 'Frosthold.exe');
await writeFile(exe2, pe());
const baseHash = await t.huellaDe(exe2);

const { DownloadManager } = require(join(ROOT, 'dist/main/download-manager.js'));
const dm = new DownloadManager();
dm.setInstallDir(juego2);
const manifiesto = {
  files: [
    { path: 'Frosthold.exe', size: (await readFile(exe2)).length, sha256: baseHash, url: 'http://x' },
  ],
};

ok((await dm.plan(manifiesto)).length === 0, 'sin tocar nada, no falta nada');

await t.aplicarLaa(exe2, true, juego2, baseHash);
const tras = await dm.plan(manifiesto);
ok(tras.length === 0, 'con la bandera puesta TAMPOCO pide volver a bajarlo');
ok((await t.leerLaa(exe2)).activo === true, 'y la bandera sigue puesta');

// Al apagarla el archivo vuelve al del manifiesto y el apunte se retira.
await t.aplicarLaa(exe2, false, juego2, baseHash);
ok((await dm.plan(manifiesto)).length === 0, 'al quitarla, sigue sin faltar nada');
ok(Object.keys(await t.leerPatched(juego2)).length === 0, 'y el apunte se borra en vez de quedarse mintiendo');

// Si el cliente se actualiza de verdad, el apunte deja de valer.
await t.aplicarLaa(exe2, true, juego2, baseHash);
const otroManifiesto = { files: [{ ...manifiesto.files[0], sha256: 'f'.repeat(64) }] };
ok(
  (await dm.plan(otroManifiesto)).length === 1,
  'si el manifiesto cambia, el apunte caduca y el archivo se vuelve a pedir'
);

await rm(juego2, { recursive: true, force: true });
await rm(dir, { recursive: true, force: true });
await rm(juego, { recursive: true, force: true });

console.log(fallos ? `\n${fallos} FALLOS\n` : '\nTodas las comprobaciones pasan\n');
process.exit(fallos ? 1 : 0);

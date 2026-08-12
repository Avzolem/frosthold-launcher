import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstallManager } from '../dist/main/install-manager.js';

let fallos = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : ' FALLO'} ${msg}`); if (!cond) fallos++; };

const im = new InstallManager();

// ── Caso 1: Config.wtf real, con la resolución rota que causa la pantalla negra
const dir = await mkdtemp(join(tmpdir(), 'wow-'));
await mkdir(join(dir, 'WTF'), { recursive: true });
const original = [
  'SET locale "esMX"',
  'SET realmList "logon.avsolem.com"',
  'SET gxResolution "3840x2160"',
  'SET gxWindow "0"',
  'SET gxRefresh "144"',
  'SET gxMonitor "1"',
  'SET Sound_MusicVolume "0.4"',
  'SET accountName "ALVATROS"',
].join('\r\n') + '\r\n';
await writeFile(join(dir, 'WTF', 'Config.wtf'), original, 'utf8');

const r = await im.resetGraphics(dir);
const salida = await readFile(r.configPath, 'utf8');
const lineas = salida.split('\r\n').filter(Boolean);

console.log('\n— Caso 1: Config.wtf con vídeo roto —');
ok(!/3840x2160|"144"|gxWindow "0"/.test(salida), 'los ajustes rotos desaparecieron');
ok(lineas.includes('SET gxResolution "1280x720"'), 'quedó 1280x720');
ok(lineas.includes('SET gxWindow "1"'), 'quedó en modo ventana');
ok(lineas.includes('SET Sound_MusicVolume "0.4"'), 'el sonido se conservó');
ok(lineas.includes('SET accountName "ALVATROS"'), 'la cuenta recordada se conservó');
ok(lineas.includes('SET realmList "logon.avsolem.com"'), 'el realmlist se conservó');
ok(salida.includes('\r\n') && !/[^\r]\n/.test(salida), 'finales de línea de Windows en todo el archivo');
ok(r.removed.length === 4, `informa los 4 ajustes reemplazados (dijo ${r.removed.length})`);
ok(r.backup !== null && (await readdir(join(dir, '.frosthold', 'backups'))).length === 1, 'se guardó copia de WTF');
ok((await readFile(join(r.backup, 'Config.wtf'), 'utf8')) === original, 'la copia conserva el archivo original intacto');

// ── Caso 2: instalación sin Config.wtf todavía
const dir2 = await mkdtemp(join(tmpdir(), 'wow-'));
const r2 = await im.resetGraphics(dir2);
const salida2 = await readFile(r2.configPath, 'utf8');
console.log('\n— Caso 2: sin Config.wtf previo —');
ok(salida2.includes('SET gxResolution "1280x720"'), 'lo crea desde cero');
ok(r2.backup === null, 'no inventa una copia si no había WTF');
ok(r2.removed.length === 0, 'no dice haber quitado nada');

// ── Caso 3: idempotencia — pulsar dos veces no duplica líneas
const r3 = await im.resetGraphics(dir);
const salida3 = await readFile(r3.configPath, 'utf8');
const cuantas = salida3.split('\r\n').filter((l) => l.startsWith('SET gxResolution')).length;
console.log('\n— Caso 3: pulsarlo dos veces —');
ok(cuantas === 1, `gxResolution aparece una sola vez (aparece ${cuantas})`);

console.log(fallos ? `\n${fallos} FALLOS\n` : '\n13 comprobaciones, todas pasan\n');
process.exit(fallos ? 1 : 0);

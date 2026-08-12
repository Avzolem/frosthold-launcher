#!/usr/bin/env node
// Comprobaciones de la carpeta del juego, del realmlist y de la traducción de
// fallos. Todo lo de aquí es lo que decide si un jugador puede empezar a jugar
// o se queda mirando un mensaje que no dice nada.

import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { InstallManager, protectedWindowsPath, isDriveRoot } = require(
  join(ROOT, 'dist/main/install-manager.js')
);
const { ProcessManager } = require(join(ROOT, 'dist/main/process-manager.js'));
const net = require(join(ROOT, 'dist/main/net-errors.js'));

let fallos = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✓' : '✖'} ${msg}${extra ? `  ${extra}` : ''}`);
  if (!cond) fallos++;
};

const im = new InstallManager();
const esRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// ── 1. Carpetas que Windows protege ─────────────────────────────────────────
console.log('\n1. Carpetas protegidas de Windows');
ok(protectedWindowsPath('C:\\Program Files\\Frosthold') === 'Archivos de programa',
  'detecta Archivos de programa');
ok(protectedWindowsPath('c:\\program files (x86)\\wow') === 'Archivos de programa (x86)',
  'detecta Archivos de programa (x86), sin importar mayúsculas');
ok(protectedWindowsPath('C:\\Windows\\System32\\juego') === 'la carpeta de Windows',
  'detecta la carpeta de Windows');
ok(protectedWindowsPath('C:\\ProgramData\\Frosthold') === 'ProgramData', 'detecta ProgramData');
ok(protectedWindowsPath('C:\\Users\\ana\\AppData\\Local\\Frosthold') === 'AppData',
  'detecta AppData, donde el juego se pierde entre carpetas del sistema');
ok(protectedWindowsPath('C:\\Users\\ana\\OneDrive\\Juegos') === 'OneDrive',
  'detecta OneDrive, que sincronizaría 16,5 GB a la nube');
ok(protectedWindowsPath('D:\\Juegos\\Frosthold') === null, 'deja pasar una carpeta normal');
ok(protectedWindowsPath('C:\\Program Files Juegos\\Frosthold') === null,
  'no confunde «Program Files Juegos» con «Program Files»');
ok(protectedWindowsPath('/home/ana/juegos') === null, 'no aplica fuera de Windows');
ok(isDriveRoot('C:\\') && isDriveRoot('D:') && !isDriveRoot('C:\\Juegos'),
  'reconoce la raíz de una unidad');

// ── 2. Veredicto sobre la carpeta elegida ───────────────────────────────────
console.log('\n2. Veredicto sobre la carpeta elegida');
const dir = await mkdtemp(join(tmpdir(), 'frosthold-target-'));

const bueno = await im.checkTarget(dir, 1024);
ok(bueno.usable && bueno.writable, 'una carpeta normal vale');
ok(typeof bueno.freeBytes === 'number' && bueno.freeBytes > 0,
  'informa del espacio libre', `${(bueno.freeBytes / 1073741824).toFixed(1)} GB`);

const sinSitio = await im.checkTarget(dir, Number.MAX_SAFE_INTEGER);
ok(!sinSitio.usable && sinSitio.blockers.some((b) => /espacio/i.test(b)),
  'rechaza la carpeta si no cabe el cliente');
ok(sinSitio.blockers.some((b) => /GB/.test(b)),
  'y lo dice con cifras, no con un «error de espacio»');

const enPrograma = await im.checkTarget('C:\\Program Files\\Frosthold', 1024);
ok(!enPrograma.usable && enPrograma.blockers.some((b) => /administrador/i.test(b)),
  'rechaza Archivos de programa antes de bajar nada');

const raiz = await im.checkTarget(dir, 1024);
ok(raiz.warnings.length === 0, 'una subcarpeta normal no genera avisos');

// Carpeta sin permiso de escritura. Como root todo es escribible, así que ahí
// la comprobación no dice nada y se salta en vez de mentir.
const cerrada = join(dir, 'cerrada');
await mkdir(cerrada);
await chmod(cerrada, 0o500);
if (esRoot) {
  console.log('  ·  (se omite la prueba de permisos: la sesión es root)');
} else {
  const t = await im.checkTarget(cerrada, 1024);
  ok(!t.usable && !t.writable, 'rechaza una carpeta donde no se puede escribir');
  ok(t.blockers.some((b) => /permite escribir|solo lectura|no se pudo escribir/i.test(b)),
    'y explica que el problema es el permiso, no la red');
}
await chmod(cerrada, 0o700);

const noExiste = join(dir, 'aun', 'no', 'existe');
ok((await im.freeSpace(noExiste)) > 0,
  'sabe el espacio libre de una carpeta que todavía no existe');

// ── 3. Realmlist en todos los idiomas presentes ─────────────────────────────
console.log('\n3. Realmlist');
const juego = await mkdtemp(join(tmpdir(), 'frosthold-juego-'));
await mkdir(join(juego, 'Data', 'esMX'), { recursive: true });
await mkdir(join(juego, 'Data', 'enUS'), { recursive: true });

const r = await im.applyRealmlist(juego, 'logon.ejemplo.com', 'esMX');
ok(r.written.length === 2, 'escribe el realmlist en TODAS las carpetas de idioma',
  `${r.written.length} archivos`);
ok(r.locale === 'esMX', 'declara esMX como idioma principal');
const esmx = await readFile(join(juego, 'Data', 'esMX', 'realmlist.wtf'), 'utf8');
const enus = await readFile(join(juego, 'Data', 'enUS', 'realmlist.wtf'), 'utf8');
ok(esmx === 'set realmlist logon.ejemplo.com\r\n', 'el contenido y los saltos de línea son los del cliente');
ok(enus === esmx, 'el cliente reutilizado en otro idioma apunta al mismo reino');

const vacio = await mkdtemp(join(tmpdir(), 'frosthold-vacio-'));
const r2 = await im.applyRealmlist(vacio, 'logon.ejemplo.com', 'esMX');
ok(r2.written.length === 1 && r2.locale === 'esMX',
  'sin carpeta Data todavía, crea la del idioma del cliente');
ok((await im.listLocales(juego)).join(',') === 'enUS,esMX', 'enumera los idiomas presentes');
ok((await im.detectLocale(juego, 'enUS')) === 'enUS', 'respeta el idioma preferido si existe');

// ── 4. ¿El juego ya está abierto, lo abriera quien lo abriera? ──────────────
console.log('\n4. Juego abierto por fuera del launcher');
const exeJuego = join(juego, 'Wow.exe');

const pmVacio = new ProcessManager(async () => []);
ok((await pmVacio.isGameRunning(juego)) === false, 'sin cliente abierto, dice que no');

const pmLleno = new ProcessManager(async () => [exeJuego]);
ok((await pmLleno.isGameRunning(juego)) === true,
  'detecta un cliente abierto desde el acceso directo, no solo el que lanzó él');

// LA REGRESIÓN DE LA v0.1.6, y por eso esta prueba existe: el launcher
// instalado se llama Frosthold.exe, igual que el juego después de renombrarlo.
// Buscando por NOMBRE se encontraba a sí mismo y daba el juego por abierto
// siempre, lo que dejaba inservibles a la vez «restablecer gráficos» y «jugar».
const pmYoMismo = new ProcessManager(async () => [process.execPath]);
ok((await pmYoMismo.isGameRunning(juego)) === false,
  'el launcher no se confunde consigo mismo aunque comparta nombre con el juego');

// Un cliente de OTRA carpeta tampoco cuenta: no vamos a tocar su Config.wtf.
const pmOtra = new ProcessManager(async () => [join(tmpdir(), 'otro-wow', 'Wow.exe')]);
ok((await pmOtra.isGameRunning(juego)) === false,
  'un cliente de otra carpeta no bloquea el arreglo de esta');

// Sin carpeta con la que comparar no se puede distinguir. Se responde que no:
// el error barato es tener que repetir el arreglo, no quedarse sin función.
ok((await pmLleno.isGameRunning()) === false,
  'sin carpeta que comparar, prefiere no bloquear antes que bloquear de más');
let lanzo = false;
try {
  await pmLleno.launch(juego, 'Wow.exe');
  lanzo = true;
} catch (err) {
  ok(/ya está abierto/i.test(err.message), 'no abre un segundo cliente encima del primero');
}
ok(!lanzo, 'y no llega a lanzar nada');
// El oyente de reserva evita que un evento 'error' sin destinatario tumbe el
// proceso principal, que es lo que pasaba al fallar el arranque del juego.
let sobrevivio = true;
try {
  new ProcessManager(async () => []).emit('error', new Error('de prueba'));
} catch {
  sobrevivio = false;
}
ok(sobrevivio, 'un fallo al abrir el juego no tumba el launcher');

// ── 5. Traducción de fallos ─────────────────────────────────────────────────
console.log('\n5. Fallos en lenguaje llano');
const sinRed = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) });
const servidorMudo = new TypeError('fetch failed', { cause: Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
ok(net.isOffline(sinRed), 'reconoce que no hay internet');
ok(!net.isOffline(servidorMudo), 'y que un servidor que no contesta es otra cosa');
ok(/no hay conexión a internet/i.test(net.networkMessage(sinRed, 'probar')),
  'sin internet se dice «no hay conexión a internet»');
ok(/no respondió a tiempo/i.test(net.networkMessage(servidorMudo, 'probar')),
  'y un servidor mudo se dice «no respondió a tiempo»');
ok(net.networkMessage(sinRed, 'probar') !== net.networkMessage(servidorMudo, 'probar'),
  'los dos casos NO comparten mensaje: era el fallo original');
ok(/404/.test(net.httpMessage(404, 'probar')) && /500/.test(net.httpMessage(500, 'probar')),
  'los códigos HTTP se cuentan con su número');
ok(net.errorCode(sinRed) === 'ENOTFOUND', 'saca el código de dentro de la cadena de causas');

const lleno = Object.assign(new Error('write'), { code: 'ENOSPC' });
const prohibido = Object.assign(new Error('open'), { code: 'EACCES' });
const cortado = Object.assign(new Error('socket'), { code: 'ECONNRESET' });
ok(net.isFatalWriteError(lleno) && net.isFatalWriteError(prohibido),
  'disco lleno y permiso denegado son fallos de los que no se sale reintentando');
ok(!net.isFatalWriteError(cortado), 'una conexión cortada sí se reintenta');
ok(/espacio/i.test(net.diskMessage(lleno)), 'el disco lleno se explica como disco lleno');
ok(/Archivos de programa/i.test(net.diskMessage(prohibido)),
  'el permiso denegado sugiere dónde NO instalar');
ok(net.diskMessage(cortado) === null, 'un fallo de red no se disfraza de fallo de disco');

// ── 6. Coherencia entre configuración y manifiesto ──────────────────────────
console.log('\n6. El manifiesto cuadra con la configuración');
{
  const { revisarCoherencia } = await import('./build-manifest.mjs');
  const config = JSON.parse(await readFile(join(ROOT, 'frosthold.config.json'), 'utf8'));
  const manifiesto = JSON.parse(
    await readFile(join(ROOT, 'dist-manifest/manifest.json'), 'utf8')
  );

  const reales = revisarCoherencia(manifiesto.files, config);
  ok(reales.length === 0, 'el manifiesto publicado cuadra con frosthold.config.json',
    reales.join(' | '));
  ok(config.clientLocale === 'esMX' && manifiesto.clientLocale === 'esMX',
    'el idioma declarado es esMX en los dos sitios');
  ok(config.rules.exclude.includes('Data/esMX/realmlist.wtf'),
    'la regla de exclusión apunta al idioma real del cliente, no a otro');

  // Un realmlist colado en el manifiesto deja al launcher bajándolo en bucle:
  // lo descarga, el arranque lo reescribe, y a la siguiente ya no cuadra.
  const conRealmlist = revisarCoherencia(
    [...manifiesto.files, { path: 'Data/esMX/realmlist.wtf', size: 30 }],
    config
  );
  ok(conRealmlist.some((p) => /realmlist/i.test(p) && /sin fin|bucle|otra vez/i.test(p)),
    'un realmlist colado en el manifiesto se detecta antes de publicarlo');

  const otroIdioma = revisarCoherencia(
    manifiesto.files.map((f) => ({ ...f, path: f.path.replace('Data/esMX/', 'Data/esES/') })),
    config
  );
  ok(otroIdioma.some((p) => /clientLocale/.test(p)),
    'un manifiesto en otro idioma que el declarado se detecta');

  const sinExe = revisarCoherencia(
    manifiesto.files.filter((f) => f.path !== config.executableName),
    config
  );
  ok(sinExe.some((p) => new RegExp(config.executableName).test(p)),
    'un manifiesto sin ejecutable se detecta');
}

// ── Cierre ──────────────────────────────────────────────────────────────────
for (const d of [dir, juego, vacio]) await rm(d, { recursive: true, force: true });
console.log(fallos ? `\n${fallos} FALLOS\n` : '\nTodas las comprobaciones pasan\n');
process.exit(fallos ? 1 : 0);

import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ConfigStore } from './config-store';
import { DownloadManager } from './download-manager';
import { InstallManager } from './install-manager';
import { ProcessManager } from './process-manager';
import { StatusManager } from './status-manager';
import {
  check as checkUpdates,
  getUpdaterState,
  install as installUpdate,
  setupUpdater,
  stopUpdater,
} from './updater';
import type { Manifest, ManifestFile } from '../shared/types';

const CONFIG = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'frosthold.config.json'), 'utf8')
) as {
  realmName: string;
  patch: string;
  realmlistHost: string;
  statusApi: string;
  manifestUrl: string;
  executableName: string;
  clientLocale: string;
};

/** Tamaño de diseño de la ventana, en píxeles independientes de la pantalla. */
const WIN_W = 1000;
const WIN_H = 640;
const MIN_W = 760;
const MIN_H = 520;

let win: BrowserWindow | null = null;
let config: ConfigStore;
let downloads: DownloadManager;
let installs: InstallManager;
let games: ProcessManager;
let status: StatusManager;
let manifest: Manifest | null = null;
let pending: ManifestFile[] = [];

function send(channel: string, payload?: unknown) {
  win?.webContents.send(channel, payload);
}

function createWindow() {
  // Con el escalado de Windows al 150 %, una ventana de 1000x640 ocupa 1500x960
  // píxeles reales: en un portátil de 1366x768 no cabe, y al no ser
  // redimensionable el botón de «Jugar» quedaba fuera de la pantalla sin
  // ninguna forma de alcanzarlo. Aquí se recorta al área de trabajo real.
  const area = screen.getPrimaryDisplay().workAreaSize;
  let width = Math.max(Math.min(WIN_W, area.width - 40), 400);
  let height = Math.max(Math.min(WIN_H, area.height - 40), 360);

  // Ayuda de desarrollo: `--window-size=760x460` reproduce lo que ve alguien
  // con un portátil pequeño y el escalado de Windows al 150 %, sin necesidad de
  // tener ese portátil.
  const forzado = /--window-size=(\d+)x(\d+)/.exec(process.argv.join(' '));
  if (forzado && !app.isPackaged) {
    width = Number(forzado[1]);
    height = Number(forzado[2]);
  }

  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(MIN_W, width),
    minHeight: Math.min(MIN_H, height),
    // Ya no es fija: en pantallas pequeñas o muy escaladas, poder estirarla es
    // la diferencia entre usar el launcher y no poder usarlo.
    resizable: true,
    maximizable: false,
    center: true,
    frame: false,
    backgroundColor: '#050b14',
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win?.show();
    // Modo de desarrollo: abre, retrata y se va. Sirve para revisar la
    // interfaz sin tener que instalar el launcher en una máquina Windows.
    if (process.argv.includes('--screenshot')) void captureAndQuit();
  });
  win.on('closed', () => {
    win = null;
  });

  // Cerrar con una descarga en marcha no rompe nada —los .part se reanudan—,
  // pero nadie lo sabe si no se lo dicen, así que se pregunta.
  win.on('close', (e) => {
    if (!downloads?.isRunning()) return;
    const elegido = dialog.showMessageBoxSync(win!, {
      type: 'question',
      buttons: ['Seguir descargando', 'Salir'],
      defaultId: 0,
      cancelId: 0,
      title: 'Hay una descarga en curso',
      message: '¿Salir con la descarga a medias?',
      detail:
        'No se pierde nada: al volver a abrir el launcher, la descarga continúa desde donde se quedó.',
    });
    if (elegido === 0) {
      e.preventDefault();
      return;
    }
    downloads.stop();
  });

  // Nada de navegación dentro de la ventana: los enlaces externos van al
  // navegador del sistema, y solo si son http(s).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/**
 * Menú mínimo e invisible. Sin él, Electron pone el suyo: en una ventana sin
 * marco no se ve, pero sus atajos siguen activos y Ctrl+R recarga la interfaz a
 * mitad de una descarga, dejándola desincronizada de lo que hace el proceso
 * principal. Se conservan copiar y seleccionar porque el realmlist y la ruta
 * del juego están para copiarse.
 */
function setupMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Frosthold',
        submenu: [
          { role: 'copy', accelerator: 'CmdOrCtrl+C' },
          { role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
          { type: 'separator' },
          { role: 'minimize', accelerator: 'CmdOrCtrl+M' },
          { role: 'quit', accelerator: 'Alt+F4' },
        ],
      },
    ])
  );
}

async function captureAndQuit() {
  const out = process.env.SHOT_PATH ?? join(app.getPath('temp'), 'frosthold-launcher.png');
  // Un respiro para que lleguen el estado del reino y la comprobación inicial.
  await new Promise((r) => setTimeout(r, 3500));
  const image = await win!.capturePage();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, image.toPNG());
  console.log(`captura: ${out}`);
  app.exit(0);
}

function wireEvents() {
  downloads.on('progress', (p) => send('download:progress', p));
  downloads.on('phase', (p) => send('download:phase', p));
  downloads.on('retry', (r) => send('download:retry', r));
  downloads.on('check-progress', (c) => send('download:check-progress', c));
  downloads.on('warning', (w) => send('download:warning', w));
  games.on('state', (s) => send('game:state', s));
  games.on('exit', () => send('game:state', 'stopped'));
  // Sin este oyente, un fallo al abrir el juego llegaba como evento 'error' sin
  // destinatario y Node tumbaba el proceso principal: el launcher se cerraba
  // solo, sin decir nada.
  games.on('error', (err: Error) => send('game:error', err.message));
  status.on('status', (s) => send('realm:status', s));
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    realmName: CONFIG.realmName,
    patch: CONFIG.patch,
    realmlistHost: CONFIG.realmlistHost,
    executableName: CONFIG.executableName,
    clientLocale: CONFIG.clientLocale,
  }));

  ipcMain.handle('config:get', () => config.get());
  ipcMain.handle('config:set', (_e, patch) => {
    const out = config.update(patch);
    const err = config.getError();
    if (err) send('config:warning', err);
    return out;
  });

  ipcMain.handle('install:select', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Elige la carpeta del juego',
      buttonLabel: 'Usar esta carpeta',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('install:inspect', async (_e, dir: string) =>
    installs.inspect(dir, CONFIG.executableName)
  );

  ipcMain.handle('install:diskSpace', async (_e, dir: string) => installs.freeSpace(dir));

  /**
   * Antes de bajar 16,5 GB: ¿se puede escribir ahí de verdad, cabe, y no es una
   * carpeta que Windows proteja? Se comprueba en cuanto se elige la carpeta,
   * no cuando fallan los archivos uno por uno.
   */
  ipcMain.handle('install:checkTarget', async (_e, dir: string, requiredBytes?: number) =>
    installs.checkTarget(dir, requiredBytes ?? manifest?.requiredFreeSpace ?? 0)
  );

  ipcMain.handle('install:applyRealmlist', async (_e, dir: string) => {
    await installs.backupSettings(dir);
    const { written, locale } = await installs.applyRealmlist(
      dir,
      CONFIG.realmlistHost,
      CONFIG.clientLocale
    );
    return { written, locale, host: CONFIG.realmlistHost };
  });

  ipcMain.handle('install:readRealmlist', async (_e, dir: string) =>
    installs.readRealmlist(dir)
  );

  ipcMain.handle('install:openDir', async (_e, dir: string) => {
    // `openPath` no lanza: devuelve el motivo en una cadena y, si nadie la mira,
    // el botón parece no hacer nada.
    const err = await shell.openPath(dir);
    if (err) throw new Error(`No se pudo abrir la carpeta: ${err}`);
    return { opened: true };
  });

  ipcMain.handle('install:resetGraphics', async (_e, dir: string) => {
    // Con el juego abierto no sirve de nada: el cliente reescribe Config.wtf
    // entero al cerrarse y se lleva por delante lo que acabamos de poner. Es
    // exactamente el motivo por el que a la gente "no le funciona" el arreglo
    // manual, así que aquí se corta antes de dar una falsa sensación de éxito.
    // Se mira el sistema, no solo lo que lanzó el launcher: el caso normal es
    // que el juego se haya abierto desde el acceso directo del escritorio. Se
    // pasa la carpeta porque la comprobación es POR RUTA — el launcher se llama
    // igual que el juego y, sin ella, se encontraba a sí mismo.
    if (await games.isGameRunning(dir)) {
      throw new Error('Cierra el juego antes de restablecer los gráficos.');
    }

    const { response } = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: ['Restablecer', 'Cancelar'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restablecer gráficos',
      message: '¿Devolver el juego a una configuración de vídeo segura?',
      detail:
        'Quedará en ventana de 1280x720. Es lo que arregla la pantalla negra ' +
        'después de cambiar la resolución.\n\n' +
        'Tus teclas, tu sonido y tu cuenta recordada no se tocan, y se guarda ' +
        'una copia de la carpeta WTF por si acaso. Tu personaje vive en el ' +
        'reino: nada de esto lo afecta.',
    });
    if (response !== 0) return { cancelled: true };

    return { cancelled: false, ...(await installs.resetGraphics(dir)) };
  });

  ipcMain.handle('download:manifest', async () => {
    manifest = await downloads.fetchManifest(CONFIG.manifestUrl);
    return manifest;
  });

  ipcMain.handle('download:plan', async (_e, deep: boolean) => {
    if (!manifest) throw new Error('Aún no se ha cargado la lista de archivos del cliente.');
    const dir = config.get().installDir;
    if (!dir) throw new Error('Falta elegir la carpeta del juego.');
    downloads.setInstallDir(dir);
    send('download:phase', 'checking');
    pending = await downloads.plan(manifest, deep);
    const bytes = pending.reduce((n, f) => n + f.size, 0);
    const yaEnDisco = await downloads.partialBytes(pending);
    send('download:phase', pending.length ? 'idle' : 'ready');
    return { files: pending.length, bytes, missingBytes: Math.max(bytes - yaEnDisco, 0) };
  });

  ipcMain.handle('download:start', async () => {
    if (!pending.length) return { started: false };
    const dir = config.get().installDir!;

    // El disco lleno a mitad de 16 GB es de los fallos más caros que hay: se
    // comprueba antes, con números, en vez de descubrirlo a las tres horas.
    const necesarios = pending.reduce((n, f) => n + f.size, 0) - (await downloads.partialBytes(pending));
    const objetivo = await installs.checkTarget(dir, Math.ceil(necesarios * 1.05));
    if (!objetivo.usable) {
      throw new Error(objetivo.blockers.join(' '));
    }

    void downloads.start(pending).catch((err: Error) => {
      send('download:error', err.message);
    });
    return { started: true, warnings: objetivo.warnings };
  });

  ipcMain.handle('download:stop', () => {
    downloads.stop();
  });

  ipcMain.handle('game:launch', async () => {
    const cfg = config.get();
    if (!cfg.installDir) throw new Error('Falta elegir la carpeta del juego.');
    const check = await installs.inspect(cfg.installDir, CONFIG.executableName);
    if (!check.executable) {
      throw new Error(
        'No se encontró el ejecutable del juego en esa carpeta. Vuelve a comprobar la instalación.'
      );
    }
    // El realmlist se reescribe en cada arranque a propósito: el cliente y
    // otros launchers lo cambian, y nadie quiere depurar «me sale otro reino».
    const { written } = await installs.applyRealmlist(
      cfg.installDir,
      CONFIG.realmlistHost,
      CONFIG.clientLocale
    );
    await games.launch(cfg.installDir, check.executable);
    if (cfg.closeOnLaunch) setTimeout(() => app.quit(), 2000);
    return { launched: true, realmlists: written.length };
  });

  ipcMain.handle('game:stop', () => games.stop());
  ipcMain.handle('game:state', () => games.getState());
  ipcMain.handle('game:running', () => games.isGameRunning(config.get().installDir ?? undefined));
  ipcMain.handle('realm:status', () => status.getLast());

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    return shell.openExternal(url);
  });

  ipcMain.handle('updater:state', () => getUpdaterState());
  ipcMain.handle('updater:check', () => checkUpdates(true));

  ipcMain.handle('updater:install', () => {
    // Instalar cierra el launcher. Con el cliente bajando, eso corta 16 GB a
    // medias: se reanudan solos al volver, pero nadie espera que pulsar
    // «actualizar» detenga su descarga, así que se avisa en vez de hacerlo.
    if (downloads.isRunning()) {
      throw new Error(
        'Hay una descarga del juego en curso. Espera a que termine o deténla antes de actualizar.'
      );
    }
    installUpdate();
    return { installing: true };
  });

  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('window:close', () => win?.close());
}

// Una sola instancia: dos launchers escribiendo en la misma carpeta se pisan.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    config = new ConfigStore(app.getPath('userData'));
    downloads = new DownloadManager();
    installs = new InstallManager();
    games = new ProcessManager();
    status = new StatusManager(CONFIG.statusApi, !app.isPackaged);

    const dir = config.get().installDir;
    if (dir) downloads.setInstallDir(dir);

    setupMenu();
    createWindow();
    wireEvents();
    registerIpc();
    status.start();
    setupUpdater(send);
  });

  app.on('window-all-closed', () => {
    status.stop();
    stopUpdater();
    downloads?.stop();
    app.quit();
  });
}

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ConfigStore } from './config-store';
import { DownloadManager } from './download-manager';
import { InstallManager } from './install-manager';
import { ProcessManager } from './process-manager';
import { StatusManager } from './status-manager';
import { setupUpdater } from './updater';
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
  win = new BrowserWindow({
    width: 1000,
    height: 640,
    resizable: false,
    frame: false,
    backgroundColor: '#050b14',
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
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

  // Nada de navegación dentro de la ventana: los enlaces externos van al
  // navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
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
  games.on('state', (s) => send('game:state', s));
  games.on('exit', () => send('game:state', 'stopped'));
  status.on('status', (s) => send('realm:status', s));
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    realmName: CONFIG.realmName,
    patch: CONFIG.patch,
    realmlistHost: CONFIG.realmlistHost,
    executableName: CONFIG.executableName,
  }));

  ipcMain.handle('config:get', () => config.get());
  ipcMain.handle('config:set', (_e, patch) => config.update(patch));

  ipcMain.handle('install:select', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Elige la carpeta del juego',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('install:inspect', async (_e, dir: string) =>
    installs.inspect(dir, CONFIG.executableName)
  );

  ipcMain.handle('install:diskSpace', async (_e, dir: string) => installs.freeSpace(dir));

  ipcMain.handle('install:applyRealmlist', async (_e, dir: string) => {
    await installs.backupSettings(dir);
    const written = await installs.applyRealmlist(dir, CONFIG.realmlistHost);
    return { written, host: CONFIG.realmlistHost };
  });

  ipcMain.handle('install:readRealmlist', async (_e, dir: string) =>
    installs.readRealmlist(dir)
  );

  ipcMain.handle('install:openDir', async (_e, dir: string) => shell.openPath(dir));

  ipcMain.handle('download:manifest', async () => {
    manifest = await downloads.fetchManifest(CONFIG.manifestUrl);
    return manifest;
  });

  ipcMain.handle('download:plan', async (_e, deep: boolean) => {
    if (!manifest) throw new Error('Aún no se ha cargado el manifiesto');
    const dir = config.get().installDir;
    if (!dir) throw new Error('Falta elegir la carpeta del juego');
    downloads.setInstallDir(dir);
    send('download:phase', 'checking');
    pending = await downloads.plan(manifest, deep);
    const bytes = pending.reduce((n, f) => n + f.size, 0);
    send('download:phase', pending.length ? 'idle' : 'ready');
    return { files: pending.length, bytes };
  });

  ipcMain.handle('download:start', async () => {
    if (!pending.length) return { started: false };
    void downloads.start(pending).catch((err: Error) => {
      send('download:error', err.message);
    });
    return { started: true };
  });

  ipcMain.handle('download:stop', () => {
    downloads.stop();
  });

  ipcMain.handle('game:launch', async () => {
    const cfg = config.get();
    if (!cfg.installDir) throw new Error('Falta elegir la carpeta del juego');
    await installs.applyRealmlist(cfg.installDir, CONFIG.realmlistHost);
    const check = await installs.inspect(cfg.installDir, CONFIG.executableName);
    if (!check.executable) throw new Error('No se encontró el ejecutable del juego');
    await games.launch(cfg.installDir, check.executable);
    if (cfg.closeOnLaunch) setTimeout(() => app.quit(), 2000);
    return { launched: true };
  });

  ipcMain.handle('game:stop', () => games.stop());
  ipcMain.handle('game:state', () => games.getState());
  ipcMain.handle('realm:status', () => status.getLast());

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    return shell.openExternal(url);
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
    status = new StatusManager(CONFIG.statusApi);

    const dir = config.get().installDir;
    if (dir) downloads.setInstallDir(dir);

    createWindow();
    wireEvents();
    registerIpc();
    status.start();
    setupUpdater(send);
  });

  app.on('window-all-closed', () => {
    status.stop();
    app.quit();
  });
}

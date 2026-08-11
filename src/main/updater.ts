import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

type Send = (channel: string, payload?: unknown) => void;

/**
 * Actualización del propio launcher. El cliente del juego se actualiza por el
 * manifiesto; esto es solo para la aplicación.
 *
 * Se descarga sola y se instala al cerrar, sin preguntar: quien abre un
 * launcher quiere jugar, no atender un diálogo de mantenimiento. Y mientras
 * el canal de actualizaciones no exista, los fallos son silenciosos — no
 * tiene sentido alarmar a nadie porque un servidor todavía no esté montado.
 */
export function setupUpdater(send: Send) {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    send('updater:available', { version: info.version });
  });

  autoUpdater.on('download-progress', (p) => {
    send('updater:progress', { percent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    send('updater:ready', { version: info.version });
  });

  autoUpdater.on('error', () => {
    /* silencio deliberado: ver el comentario de arriba */
  });

  // Un respiro tras el arranque para no competir por la red con la
  // comprobación del cliente, que es lo que el jugador está esperando.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, 8000);
}

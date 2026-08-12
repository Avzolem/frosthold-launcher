import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

type Send = (channel: string, payload?: unknown) => void;

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'unsupported'
  | 'error';

export interface UpdaterState {
  phase: UpdaterPhase;
  /** Versión disponible, no la instalada. */
  version: string | null;
  percent: number;
  message: string | null;
  /** Momento de la última comprobación, en epoch, o null si no hubo ninguna. */
  checkedAt: number | null;
}

/**
 * Actualización del propio launcher. El cliente del juego se actualiza por el
 * manifiesto; esto es solo para la aplicación.
 *
 * Se descarga sola y se instala al cerrar. Antes eso ocurría del todo a
 * ciegas: el proceso principal emitía eventos que la interfaz no escuchaba,
 * así que quien tenía una versión vieja no se enteraba nunca y solo recibía
 * la nueva si cerraba la aplicación por su cuenta. Ahora el estado se publica
 * y además se puede instalar en el momento.
 */

// Cada seis horas. Un launcher abierto de fondo durante días llegaba a la
// comprobación única del arranque y no volvía a mirar jamás.
const RECHECK_MS = 6 * 60 * 60 * 1000;

const state: UpdaterState = {
  phase: 'idle',
  version: null,
  percent: 0,
  message: null,
  checkedAt: null,
};

let send: Send = () => {};
let timer: NodeJS.Timeout | null = null;

export function getUpdaterState(): UpdaterState {
  return { ...state };
}

function set(patch: Partial<UpdaterState>) {
  Object.assign(state, patch);
  send('updater:state', getUpdaterState());
}

export function setupUpdater(emit: Send) {
  send = emit;

  if (!app.isPackaged) {
    // Sin empaquetar, electron-updater no tiene dónde mirar. Se dice
    // explícitamente para que la interfaz muestre «no disponible» en vez de
    // quedarse en «comprobando…» para siempre.
    //
    // FROSTHOLD_FAKE_UPDATE finge una fase para poder revisar la barra de
    // aviso sin tener dos versiones publicadas. Vive dentro de esta rama a
    // propósito: en una versión instalada es código inalcanzable.
    const fingida = process.env.FROSTHOLD_FAKE_UPDATE as UpdaterPhase | undefined;
    if (fingida) {
      set({ phase: fingida, version: '9.9.9', percent: 42, message: 'Fallo de mentira, para revisar el aviso.' });
      return;
    }
    set({
      phase: 'unsupported',
      message: 'Las actualizaciones solo funcionan en la versión instalada.',
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    set({ phase: 'downloading', version: info.version, percent: 0, message: null });
  });

  autoUpdater.on('update-not-available', () => {
    set({ phase: 'uptodate', version: null, message: null, checkedAt: Date.now() });
  });

  autoUpdater.on('download-progress', (p) => {
    set({ phase: 'downloading', percent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    set({ phase: 'ready', version: info.version, percent: 100, message: null });
  });

  autoUpdater.on('error', () => {
    // Esto cubre los fallos de FONDO: sobre todo que se caiga la descarga a
    // medias. Casi siempre es que no hay internet, y pintar eso en rojo asusta
    // sin motivo, así que se vuelve al reposo en silencio y ya se reintentará.
    // Los fallos de una comprobación que pidió el jugador los cuenta `check`,
    // que sí tiene derecho a una respuesta.
    if (state.phase !== 'ready') set({ phase: 'idle', percent: 0, message: null });
  });

  // Un respiro tras el arranque para no competir por la red con la
  // comprobación del cliente, que es lo que el jugador está esperando.
  setTimeout(() => void check(false), 8000);
  timer = setInterval(() => void check(false), RECHECK_MS);
}

/** Traduce los fallos habituales a algo que un jugador pueda entender. */
function mensajeDeError(err: Error): string {
  const t = String(err?.message ?? err);
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT/i.test(t)) {
    return 'No hay conexión para comprobar si existe una versión nueva.';
  }
  if (/404/.test(t)) {
    return 'Todavía no hay ninguna versión publicada.';
  }
  return 'No se pudo comprobar si hay una versión nueva.';
}

export async function check(manual: boolean): Promise<UpdaterState> {
  if (!app.isPackaged) return getUpdaterState();
  // Una descarga ya terminada no se vuelve a buscar: no hay nada mejor que
  // encontrar y perderíamos el aviso de que hay una lista para instalar.
  if (state.phase === 'ready' || state.phase === 'downloading') return getUpdaterState();

  set({ phase: 'checking', message: null });
  try {
    await autoUpdater.checkForUpdates();
    // Si no hubo evento, `update-not-available` o `update-available` ya
    // movieron la fase. Que siga en 'checking' significa que no llegó nada.
    if (state.phase === 'checking') set({ phase: 'uptodate', checkedAt: Date.now() });
  } catch (err) {
    if (manual) set({ phase: 'error', message: mensajeDeError(err as Error) });
    else if (state.phase === 'checking') set({ phase: 'idle', message: null });
  }
  return getUpdaterState();
}

/**
 * Cierra el launcher e instala. El juego, si está abierto, sobrevive: se lanza
 * suelto y con `unref`, así que no cuelga de este proceso.
 */
export function install(): void {
  if (state.phase !== 'ready') throw new Error('No hay ninguna actualización descargada.');
  // `isSilent` en false enseña el instalador; `isForceRunAfter` vuelve a abrir
  // el launcher al terminar, que es lo que espera quien pulsó el botón.
  autoUpdater.quitAndInstall(false, true);
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type GameState = 'stopped' | 'running';

/** Nombres de ejecutable del cliente 3.3.5a que nos pueden interesar. */
const NOMBRES = ['Frosthold.exe', 'Wow.exe', 'WoW.exe', 'wow.exe'];

/**
 * Devuelve los procesos abiertos cuyo ejecutable coincide con alguno de
 * `nombres`. Se inyecta para poder probar la lógica sin depender del sistema.
 */
export type ProcessLister = (nombres: string[]) => Promise<string[]>;

/** Lista real del sistema. Fuera de Windows no hay cliente que buscar. */
export const listarProcesosDelSistema: ProcessLister = async (nombres) => {
  if (process.platform !== 'win32') return [];
  const encontrados = new Set<string>();
  for (const nombre of nombres) {
    try {
      // /NH quita la cabecera; el filtro lo aplica el propio tasklist, así que
      // no hace falta interpretar toda la lista de procesos del equipo.
      const { stdout } = await run(
        'tasklist',
        ['/NH', '/FI', `IMAGENAME eq ${nombre}`],
        { windowsHide: true, timeout: 8000 }
      );
      if (stdout.toLowerCase().includes(nombre.toLowerCase())) encontrados.add(nombre);
    } catch {
      // Si tasklist no está disponible, se responde «no sé» en vez de «no hay»:
      // quien decide qué hacer con eso es quien llama.
    }
  }
  return [...encontrados];
};

export class ProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: GameState = 'stopped';

  constructor(private lister: ProcessLister = listarProcesosDelSistema) {
    super();
    // Un `EventEmitter` sin oyente de 'error' no ignora el evento: lo convierte
    // en una excepción no capturada que tumba el proceso principal entero. Un
    // antivirus bloqueando el ejecutable cerraba el launcher de golpe, sin
    // mensaje. Este oyente de reserva garantiza que eso no vuelva a pasar,
    // aunque quien nos use se olvide de escuchar.
    this.on('error', () => {});
  }

  getState(): GameState {
    return this.state;
  }

  /**
   * ¿Hay un cliente abierto, lo haya lanzado quien lo haya lanzado?
   *
   * El launcher solo sabía de los procesos que arrancaba él. Quien abría el
   * juego desde el acceso directo del escritorio y luego pulsaba «Restablecer
   * gráficos» recibía un «listo» rotundo, y al cerrar el juego el cliente
   * reescribía Config.wtf y se llevaba por delante el arreglo. Justo el fallo
   * que esa función existe para evitar.
   */
  async isGameRunning(): Promise<boolean> {
    if (this.state === 'running') return true;
    const vivos = await this.lister(NOMBRES);
    return vivos.length > 0;
  }

  async launch(installDir: string, executableName: string): Promise<void> {
    if (this.child) throw new Error('El juego ya está abierto');
    if (await this.isGameRunning()) {
      throw new Error(
        'El juego ya está abierto. Cámbiate a esa ventana, o ciérrala si se quedó colgada.'
      );
    }

    const exe = join(installDir, executableName);
    try {
      await access(exe, constants.F_OK);
    } catch {
      throw new Error(`No se encontró ${executableName} en la carpeta del juego`);
    }

    // `cwd` tiene que ser la carpeta del juego: el cliente busca Data/ y WTF/
    // relativos al directorio de trabajo, no a la ubicación del ejecutable.
    const child = spawn(exe, [], {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
    });
    this.child = child;

    // `spawn` no falla al momento: un ejecutable bloqueado por el antivirus o
    // corrupto avisa por el evento 'error', que puede llegar después. Hasta
    // entonces no damos el juego por arrancado.
    const arranque = new Promise<void>((resolve, reject) => {
      const ok = () => {
        child.removeListener('error', ko);
        resolve();
      };
      const ko = (err: NodeJS.ErrnoException) => {
        clearTimeout(t);
        this.child = null;
        this.setState('stopped');
        reject(
          new Error(
            err.code === 'EACCES' || err.code === 'EPERM'
              ? 'Windows o el antivirus impidieron abrir el juego. Prueba a permitir el ejecutable o a mover el juego a otra carpeta.'
              : `No se pudo abrir el juego: ${err.message}`
          )
        );
      };
      const t = setTimeout(ok, 400);
      child.once('error', ko);
    });

    child.on('exit', (code) => {
      this.child = null;
      this.setState('stopped');
      this.emit('exit', code);
    });

    child.on('error', (err) => {
      this.child = null;
      this.setState('stopped');
      this.emit('error', err);
    });

    await arranque;
    this.setState('running');

    // Soltamos el proceso: si el jugador cierra el launcher, el juego sigue.
    child.unref();
  }

  stop() {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.setState('stopped');
  }

  private setState(s: GameState) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }
}

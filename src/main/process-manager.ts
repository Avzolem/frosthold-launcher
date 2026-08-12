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
 * Devuelve la RUTA COMPLETA de cada proceso abierto cuyo ejecutable se llame
 * como alguno de `nombres`. Se inyecta para poder probar sin el sistema.
 *
 * La ruta y no el nombre, y la diferencia no es cosmética: el launcher
 * instalado TAMBIÉN se llama Frosthold.exe —lo nombra `productName` de
 * electron-builder— igual que el ejecutable del juego después de renombrarlo.
 * Buscando por nombre, el launcher se encontraba a sí mismo y daba el juego por
 * abierto siempre. Con la ruta se distinguen, y de paso se resuelve solo el
 * caso de Electron, que abre varios procesos —principal, pintado, GPU— todos
 * con el mismo nombre y la misma ruta.
 */
export type ProcessLister = (nombres: string[]) => Promise<string[]>;

/** Lista real del sistema. Fuera de Windows no hay cliente que buscar. */
export const listarProcesosDelSistema: ProcessLister = async (nombres) => {
  if (process.platform !== 'win32') return [];

  // Se pregunta por todos los nombres de una vez: una sola llamada en vez de
  // cuatro, y en Windows los nombres de archivo no distinguen mayúsculas, así
  // que las variantes de Wow.exe colapsan solas.
  const filtro = [...new Set(nombres.map((n) => n.toLowerCase()))]
    .map((n) => `Name='${n.replace(/'/g, "''")}'`)
    .join(' or ');

  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "${filtro}" | ForEach-Object { $_.ExecutablePath }`,
      ],
      { windowsHide: true, timeout: 10_000 }
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // Sin PowerShell no se puede saber la ruta, y sin la ruta no se puede
    // distinguir el juego del propio launcher. Se responde «no hay» a
    // propósito: ver `isGameRunning` para por qué esa es la respuesta menos
    // dañina cuando no se sabe.
    return [];
  }
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
   * ¿Hay un cliente abierto en `installDir`, lo haya lanzado quien lo haya
   * lanzado?
   *
   * El launcher solo sabía de los procesos que arrancaba él. Quien abría el
   * juego desde el acceso directo del escritorio y luego pulsaba «Restablecer
   * gráficos» recibía un «listo» rotundo, y al cerrar el juego el cliente
   * reescribía Config.wtf y se llevaba por delante el arreglo.
   *
   * Se compara la RUTA, nunca el nombre. El launcher instalado se llama
   * Frosthold.exe igual que el juego, así que buscar por nombre lo encontraba a
   * él y daba el juego por abierto SIEMPRE: eso dejaba inservibles tanto este
   * aviso como el botón de jugar, que también pasa por aquí.
   *
   * Cuando no se puede saber —sin PowerShell, o sin carpeta que comparar— se
   * responde que NO. Es deliberado: equivocarse por decir «no está abierto»
   * cuesta que el cliente pise el arreglo al cerrarse y haya que repetirlo;
   * equivocarse por decir «sí está abierto» deja al jugador sin poder usar la
   * función, sin nada que pueda hacer al respecto. El error barato es el
   * primero.
   */
  async isGameRunning(installDir?: string): Promise<boolean> {
    // Lo que lanzó este launcher lo sabemos sin preguntarle al sistema.
    if (this.state === 'running') return true;
    if (!installDir) return false;

    const rutas = await this.lister(NOMBRES);
    if (!rutas.length) return false;

    // Windows no distingue mayúsculas ni la barra que se use al escribir una
    // ruta, así que se normalizan las dos antes de compararlas.
    const normal = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const carpeta = `${normal(installDir)}/`;
    const yo = normal(process.execPath);

    return rutas.some((ruta) => {
      const r = normal(ruta);
      // El propio launcher y sus procesos hijos comparten ejecutable: caen
      // todos con esta sola comparación.
      if (r === yo) return false;
      return r.startsWith(carpeta);
    });
  }

  async launch(installDir: string, executableName: string): Promise<void> {
    if (this.child) throw new Error('El juego ya está abierto');
    if (await this.isGameRunning(installDir)) {
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

import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export type GameState = 'stopped' | 'running';

export class ProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: GameState = 'stopped';

  getState(): GameState {
    return this.state;
  }

  async launch(installDir: string, executableName: string): Promise<void> {
    if (this.child) throw new Error('El juego ya está abierto');

    const exe = join(installDir, executableName);
    try {
      await access(exe, constants.F_OK);
    } catch {
      throw new Error(`No se encontró ${executableName} en la carpeta del juego`);
    }

    // `cwd` tiene que ser la carpeta del juego: el cliente busca Data/ y WTF/
    // relativos al directorio de trabajo, no a la ubicación del ejecutable.
    this.child = spawn(exe, [], {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
    });

    this.setState('running');

    this.child.on('exit', (code) => {
      this.child = null;
      this.setState('stopped');
      this.emit('exit', code);
    });

    this.child.on('error', (err) => {
      this.child = null;
      this.setState('stopped');
      this.emit('error', err);
    });

    // Soltamos el proceso: si el jugador cierra el launcher, el juego sigue.
    this.child.unref();
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

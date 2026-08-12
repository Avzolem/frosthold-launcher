import { EventEmitter } from 'node:events';
import { fetchWithHeaderTimeout, networkMessage } from './net-errors';

/** Espejo del contrato que sirve el sitio en /api/wow/status. */
export interface RealmStatus {
  state: 'up' | 'down' | 'unknown';
  authUp: 'up' | 'down' | 'unknown';
  worldUp: 'up' | 'down' | 'unknown';
  at: string | null;
  ageSeconds: number | null;
  bootedAt: string | null;
  playersOnline: number | null;
  accounts: number | null;
  characters: number | null;
}

/**
 * La lectura, más lo que sabemos de la lectura en sí. La doctrina de la casa es
 * que un dato viejo se declara viejo: nunca se sirve una cifra de hace media
 * hora como si fuera de ahora, ni se pinta un cero donde no hubo lectura.
 */
export interface RealmReading {
  status: RealmStatus | null;
  /** Cuándo consiguió el launcher esta lectura, en epoch. Null si nunca hubo. */
  fetchedAt: number | null;
  /** Antigüedad total del dato en segundos: lo que tardó el reino + lo que lleva aquí. */
  ageSeconds: number | null;
  /** Por qué falló el último intento, si falló. Null si la última fue buena. */
  error: string | null;
}

const POLL_MS = 30_000;
const TIMEOUT_MS = 10_000;

export class StatusManager extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private status: RealmStatus | null = null;
  private fetchedAt: number | null = null;
  private error: string | null = null;

  /**
   * @param dev  Permite las simulaciones de FROSTHOLD_FAKE_STATUS. Solo se pasa
   *             en true sin empaquetar; en una versión instalada esa rama es
   *             código inalcanzable.
   */
  constructor(private url: string, private dev = false) {
    super();
  }

  start() {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** La última lectura, con su edad calculada en el momento de preguntar. */
  getLast(): RealmReading {
    const propia = this.fetchedAt != null ? Math.floor((Date.now() - this.fetchedAt) / 1000) : null;
    // La edad que cuenta es la del dato, no la de nuestra consulta: el sitio ya
    // nos dice cuánto llevaba guardado cuando nos lo dio.
    const ageSeconds =
      propia == null ? null : propia + (this.status?.ageSeconds ?? 0);
    return { status: this.status, fetchedAt: this.fetchedAt, ageSeconds, error: this.error };
  }

  /**
   * Finge una lectura para poder revisar cómo se pinta un dato viejo sin
   * esperar a que el reino se caiga. `reciente`, `vieja`, `caduca` o `sin`.
   */
  private simulacion(): boolean {
    const modo = this.dev ? process.env.FROSTHOLD_FAKE_STATUS : undefined;
    if (!modo) return false;

    const base: RealmStatus = {
      state: 'up',
      authUp: 'up',
      worldUp: 'up',
      at: new Date().toISOString(),
      ageSeconds: 0,
      bootedAt: new Date(Date.now() - 9_000_000).toISOString(),
      playersOnline: 2,
      accounts: 4,
      characters: 2,
    };

    if (modo === 'sin') {
      this.status = null;
      this.fetchedAt = null;
      this.error = 'No hay conexión a internet: no se pudo encontrar el servidor del reino.';
    } else {
      this.status = { ...base, ageSeconds: modo === 'caduca' ? 4200 : modo === 'vieja' ? 420 : 20 };
      this.fetchedAt = Date.now();
      this.error = null;
    }
    this.emit('status', this.getLast());
    return true;
  }

  private async poll() {
    if (this.simulacion()) return;
    try {
      const res = await fetchWithHeaderTimeout(this.url, {}, TIMEOUT_MS);
      if (!res.ok) throw new Error(`el servidor respondió ${res.status}`);
      this.status = (await res.json()) as RealmStatus;
      this.fetchedAt = Date.now();
      this.error = null;
    } catch (err) {
      // Un fallo de red no significa que el reino esté caído: conservamos la
      // última lectura buena, la marcamos con su edad y decimos qué pasó. Lo
      // que no se hace nunca es enseñar la cifra vieja como si fuera de ahora.
      this.error = networkMessage(err, 'consultar el estado del reino');
    }
    this.emit('status', this.getLast());
  }
}

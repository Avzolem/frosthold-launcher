import { EventEmitter } from 'node:events';

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

const POLL_MS = 30_000;

export class StatusManager extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private last: RealmStatus | null = null;

  constructor(private url: string) {
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

  getLast(): RealmStatus | null {
    return this.last;
  }

  private async poll() {
    try {
      const res = await fetch(this.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(String(res.status));
      this.last = (await res.json()) as RealmStatus;
      this.emit('status', this.last);
    } catch {
      // Un fallo de red no significa que el reino esté caído: conservamos la
      // última lectura buena y lo marcamos como desconocido.
      this.emit('status', this.last ?? null);
    }
  }
}

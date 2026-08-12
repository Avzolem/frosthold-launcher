/**
 * Traducción de fallos de red y de disco a frases que un jugador pueda leer y,
 * sobre todo, actuar.
 *
 * Por qué existe este archivo: `fetch` de Node no lanza el error de verdad,
 * lanza un `TypeError: fetch failed` con el motivo colgando de `cause`. Eso
 * llegaba tal cual a la interfaz, así que quien no tenía internet y quien tenía
 * el servidor caído leían exactamente el mismo «fetch failed» y no podían
 * distinguir un problema suyo de uno nuestro.
 */

/** Recorre la cadena de `cause` hasta encontrar un `code` de sistema. */
export function errorCode(err: unknown): string {
  const visto = new Set<unknown>();
  let e: unknown = err;
  while (e && typeof e === 'object' && !visto.has(e)) {
    visto.add(e);
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && c) return c;
    e = (e as { cause?: unknown }).cause;
  }
  return '';
}

/** Igual, pero con el `name` (AbortError, TimeoutError…). */
export function errorName(err: unknown): string {
  const visto = new Set<unknown>();
  let e: unknown = err;
  while (e && typeof e === 'object' && !visto.has(e)) {
    visto.add(e);
    const n = (e as { name?: unknown }).name;
    if (typeof n === 'string' && n && n !== 'Error' && n !== 'TypeError') return n;
    e = (e as { cause?: unknown }).cause;
  }
  return '';
}

const SIN_INTERNET = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
]);

const TIEMPO = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

const CORTE = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE']);

/**
 * ¿El fallo dice «no tienes internet» en vez de «el servidor falla»?
 * La diferencia importa: en un caso el jugador puede hacer algo, en el otro no.
 */
export function isOffline(err: unknown): boolean {
  return SIN_INTERNET.has(errorCode(err));
}

/**
 * @param que  Qué se estaba intentando, en minúsculas y sin punto final.
 *             Ej.: «descargar la lista de archivos del cliente».
 */
export function networkMessage(err: unknown, que: string): string {
  const code = errorCode(err);
  const name = errorName(err);

  if (SIN_INTERNET.has(code)) {
    return `No hay conexión a internet: no se pudo ni siquiera encontrar el servidor para ${que}. Revisa tu red y vuelve a intentarlo.`;
  }
  if (TIEMPO.has(code) || name === 'TimeoutError') {
    return `El servidor no respondió a tiempo al ${que}. Puede estar saturado; inténtalo de nuevo en unos minutos.`;
  }
  if (code === 'ECONNREFUSED') {
    return `El servidor rechazó la conexión al ${que}. Está encendido pero no está atendiendo; inténtalo más tarde.`;
  }
  if (CORTE.has(code)) {
    return `La conexión se cortó a mitad de ${que}. Suele ser cosa de la red; se puede reintentar sin perder lo ya descargado.`;
  }
  if (code.startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return `No se pudo verificar el certificado del servidor al ${que}. Si estás en una red con filtro o antivirus que inspecciona el tráfico, prueba en otra red.`;
  }
  if (name === 'AbortError') {
    return `Se canceló ${que}.`;
  }

  const detalle = err instanceof Error ? err.message : String(err);
  return `No se pudo ${que}. ${detalle}`;
}

/** Un código HTTP contado como lo contaría una persona. */
export function httpMessage(status: number, que: string): string {
  if (status === 404) {
    return `No se encontró lo necesario para ${que} (404). Es un problema nuestro, no tuyo: avisa en la comunidad.`;
  }
  if (status === 403) {
    return `El servidor negó el acceso para ${que} (403).`;
  }
  if (status === 429) {
    return `Demasiadas peticiones seguidas para ${que} (429). Espera un momento y vuelve a intentarlo.`;
  }
  if (status >= 500) {
    return `El servidor está fallando al ${que} (${status}). No es cosa de tu equipo; inténtalo más tarde.`;
  }
  return `Respuesta inesperada del servidor al ${que} (${status}).`;
}

// ── Disco ────────────────────────────────────────────────────────────────────

/**
 * Fallos de escritura que NO tiene sentido reintentar: el disco lleno no se
 * vacía solo entre intento e intento, y una carpeta sin permiso no los gana.
 * Reintentar cuatro veces cada uno de 141 archivos solo alarga la agonía y deja
 * al jugador mirando una barra que no avanza.
 */
const DISCO_FATAL = new Set([
  'ENOSPC',
  'EDQUOT',
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'ENAMETOOLONG',
  'EBUSY',
]);

export function isFatalWriteError(err: unknown): boolean {
  return DISCO_FATAL.has(errorCode(err));
}

/** Devuelve la frase para un fallo de disco, o null si el fallo no es de disco. */
export function diskMessage(err: unknown, dir?: string): string | null {
  const code = errorCode(err);
  const donde = dir ? ` (${dir})` : '';

  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return `Se acabó el espacio en el disco${donde}. Libera sitio y vuelve a pulsar «Descargar»: lo que ya bajaste se conserva y continúa desde donde iba.`;
    case 'EACCES':
    case 'EPERM':
      return `Windows no permite escribir en esa carpeta${donde}. Elige una carpeta tuya —por ejemplo dentro de Documentos o en la raíz de otra unidad— y evita «Archivos de programa».`;
    case 'EROFS':
      return `Esa unidad${donde} es de solo lectura. Elige otra carpeta.`;
    case 'ENOTDIR':
    case 'EEXIST':
      return `Hay un archivo donde debería ir una carpeta${donde}. Renombra o quita ese archivo y vuelve a intentarlo.`;
    case 'EISDIR':
      return `Hay una carpeta donde debería ir un archivo${donde}. Renómbrala y vuelve a intentarlo.`;
    case 'ENAMETOOLONG':
      return `La ruta es demasiado larga para Windows${donde}. Elige una carpeta más cerca de la raíz del disco, por ejemplo D:\\Frosthold.`;
    case 'EBUSY':
      return `Un archivo del juego está en uso${donde}. Cierra el juego y vuelve a intentarlo.`;
    default:
      return null;
  }
}

// ── fetch con tiempo límite de cabeceras ─────────────────────────────────────

/**
 * `fetch` de Node no tiene tiempo límite: una conexión que se queda colgada
 * espera para siempre y el launcher se queda «comprobando…» eternamente.
 *
 * El límite cubre solo hasta que llegan las cabeceras. No puede cubrir el
 * cuerpo: bajar un MPQ de 2 GB tarda legítimamente más que cualquier plazo que
 * quisiéramos poner. Del cuerpo parado se encarga el vigía de la descarga.
 */
export async function fetchWithHeaderTimeout(
  url: string,
  init: { headers?: Record<string, string>; method?: string; signal?: AbortSignal },
  ms: number
): Promise<Response> {
  const ctl = new AbortController();
  const externa = init.signal;

  const alAbortar = () => ctl.abort(externa?.reason);
  if (externa) {
    if (externa.aborted) ctl.abort(externa.reason);
    else externa.addEventListener('abort', alAbortar);
  }

  const timer = setTimeout(
    () => ctl.abort(new DOMException(`sin respuesta en ${Math.round(ms / 1000)} s`, 'TimeoutError')),
    ms
  );

  try {
    return await fetch(url, {
      method: init.method,
      headers: init.headers,
      redirect: 'follow',
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
    // Sin esto, cada archivo del manifiesto deja un oyente pegado a la señal
    // global de la descarga y a los 141 archivos Node empieza a avisar de fugas.
    if (externa) externa.removeEventListener('abort', alAbortar);
  }
}

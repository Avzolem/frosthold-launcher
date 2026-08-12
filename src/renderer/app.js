/* global frosthold */
'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  stateDot: $('state-dot'),
  stateLabel: $('state-label'),
  stateAge: $('state-age'),
  players: $('m-players'),
  accounts: $('m-accounts'),
  uptime: $('m-uptime'),
  path: $('install-path'),
  note: $('client-note'),
  progress: $('progress'),
  bar: $('bar'),
  barFill: $('bar-fill'),
  progressText: $('progress-text'),
  progressSpeed: $('progress-speed'),
  primary: $('btn-primary'),
  stop: $('btn-stop'),
  choose: $('btn-choose'),
  error: $('error'),
  warning: $('warning'),
  realmlist: $('realmlist-host'),
  tools: $('tools'),
  openDir: $('btn-open-dir'),
  resetGfx: $('btn-reset-gfx'),
  verify: $('btn-verify'),
  checkUpdate: $('btn-check-update'),
  update: $('update'),
  updateText: $('update-text'),
  updateAction: $('btn-update'),
};

/** Qué puede hacer el botón grande en cada momento. */
let mode = 'choose'; // choose | check | download | downloading | play
let installDir = null;
let pendingBytes = 0;

/**
 * Umbrales de la edad del dato del reino, en segundos.
 * `VIEJO`: sigue sirviendo, pero declarado viejo.
 * `CADUCO`: deja de servirse. Enseñar «3 conectados» de hace media hora es
 * peor que no enseñar nada: quien lo lee se lo cree.
 */
const VIEJO = 180;
const CADUCO = 1800;

// ── Formato ─────────────────────────────────────────────────────────────────

function bytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

function duration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${Math.max(Math.floor(sec), 0)} s`;
}

function showError(msg) {
  ui.error.textContent = msg ?? '';
  ui.error.hidden = !msg;
}

function showWarning(msg) {
  ui.warning.textContent = msg ?? '';
  ui.warning.hidden = !msg;
}

// ── Estado del reino ────────────────────────────────────────────────────────

/**
 * Escribe una cifra. Si no hay dato pone una raya, y la raya va en gris: el
 * dorado es para los datos que existen, no para los huecos.
 */
function metric(el, valor) {
  const hay = valor !== null && valor !== undefined;
  el.textContent = hay ? valor : '—';
  el.classList.toggle('empty', !hay);
}

/** Vacía las cifras. Nunca se pinta un cero donde no hubo lectura. */
function blankMetrics() {
  metric(ui.players, null);
  metric(ui.accounts, null);
  metric(ui.uptime, null);
}

/**
 * `reading` es {status, fetchedAt, ageSeconds, error}. La edad manda: sin dato
 * reciente no se pinta una cifra, y desde luego no se pinta un cero.
 */
function paintStatus(reading) {
  const s = reading && reading.status;
  const edad = reading ? reading.ageSeconds : null;

  if (!s || edad == null) {
    ui.stateDot.dataset.state = 'unknown';
    ui.stateLabel.textContent = 'Sin datos del reino';
    ui.stateAge.textContent = reading && reading.error ? reading.error : '';
    blankMetrics();
    return;
  }

  if (edad > CADUCO) {
    // Deja de servirse el dato en vez de servirlo con una nota al pie.
    ui.stateDot.dataset.state = 'unknown';
    ui.stateLabel.textContent = 'Sin lectura reciente del reino';
    ui.stateAge.textContent = `la última fue hace ${duration(edad)}`;
    blankMetrics();
    return;
  }

  ui.stateDot.dataset.state = s.state;
  ui.stateLabel.textContent =
    s.state === 'up'
      ? 'El reino está en línea'
      : s.state === 'down'
        ? 'El reino está caído'
        : 'Sin datos recientes del reino';

  ui.stateAge.textContent = edad > VIEJO ? `lectura de hace ${duration(edad)}` : '';
  ui.stateAge.classList.toggle('stale', edad > VIEJO);

  metric(ui.players, s.playersOnline);
  metric(ui.accounts, s.accounts);
  metric(
    ui.uptime,
    s.bootedAt ? duration(Math.floor((Date.now() - new Date(s.bootedAt).getTime()) / 1000)) : null
  );
}

// Sin esto, una lectura de hace 20 minutos seguiría diciendo «hace 30 s» hasta
// que llegara la siguiente. La edad se recalcula sola.
let ultimaLectura = null;
setInterval(() => {
  if (ultimaLectura && ultimaLectura.fetchedAt) {
    const propia = Math.floor((Date.now() - ultimaLectura.fetchedAt) / 1000);
    const delServidor = ultimaLectura.status?.ageSeconds ?? 0;
    paintStatus({ ...ultimaLectura, ageSeconds: propia + delServidor });
  }
}, 15000);

// ── Carpeta del juego ───────────────────────────────────────────────────────

async function useDir(dir) {
  installDir = dir;
  ui.path.textContent = dir;
  ui.path.title = dir;
  ui.openDir.disabled = false;
  ui.resetGfx.disabled = false;
  ui.verify.disabled = false;
  showError('');
  showWarning('');
  await frosthold.config.set({ installDir: dir });

  const check = await frosthold.install.inspect(dir);
  ui.note.className = 'note';
  ui.note.textContent = check.ok
    ? `Cliente encontrado (${check.executable}, idioma ${check.locale}). Comprobando qué falta…`
    : 'Comprobando qué hace falta descargar…';

  setMode('check');
  await runPlan(false);
}

async function runPlan(deep) {
  showError('');
  ui.primary.disabled = true;
  try {
    await frosthold.download.manifest();
    const plan = await frosthold.download.plan(Boolean(deep));
    pendingBytes = plan.missingBytes ?? plan.bytes;

    if (plan.files === 0) {
      ui.note.className = 'note good';
      ui.note.textContent = 'El cliente está completo y verificado.';
      setMode('play');
      await avisarDeLaCarpeta(0);
      return;
    }

    ui.note.className = 'note';
    ui.note.textContent =
      `Faltan ${plan.files} ${plan.files === 1 ? 'archivo' : 'archivos'} (${bytes(pendingBytes)}).` +
      (plan.bytes !== pendingBytes ? ` Ya hay ${bytes(plan.bytes - pendingBytes)} bajados a medias.` : '');
    setMode('download');
    await avisarDeLaCarpeta(pendingBytes);
  } catch (err) {
    showError(err.message ?? String(err));
    setMode('check');
  } finally {
    if (mode !== 'downloading') ui.primary.disabled = false;
  }
}

/**
 * Lo que hay que saber de la carpeta ANTES de pulsar «Descargar»: si Windows
 * la protege, si se puede escribir en ella y si cabe. Descubrirlo a las tres
 * horas de descarga es el peor momento posible.
 */
async function avisarDeLaCarpeta(necesarios) {
  if (!installDir) return;
  try {
    const t = await frosthold.install.checkTarget(installDir, Math.ceil(necesarios * 1.05));
    if (!t.usable) {
      showError(t.blockers.join(' '));
      showWarning('');
      setMode('check');
      return;
    }
    showWarning(t.warnings.join(' '));
  } catch {
    // Que falle la comprobación no puede impedir seguir: como mucho nos
    // quedamos sin el aviso previo.
  }
}

// ── Botón principal ─────────────────────────────────────────────────────────

function setMode(next) {
  mode = next;
  ui.primary.disabled = false;
  ui.stop.hidden = true;

  if (next === 'choose') {
    // Antes este botón estaba apagado en el primer arranque: el control más
    // grande de la ventana no hacía nada y la única salida era un botón
    // secundario en la esquina.
    ui.primary.textContent = 'Elegir la carpeta del juego';
  } else if (next === 'check') {
    ui.primary.textContent = 'Comprobar de nuevo';
  } else if (next === 'download') {
    ui.primary.textContent = `Descargar ${bytes(pendingBytes)}`;
  } else if (next === 'downloading') {
    ui.primary.textContent = 'Descargando…';
    ui.primary.disabled = true;
    ui.stop.hidden = false;
  } else if (next === 'play') {
    ui.primary.textContent = 'Jugar';
  }
}

ui.primary.addEventListener('click', async () => {
  showError('');
  const previo = mode;
  try {
    if (mode === 'choose') {
      await elegirCarpeta();
    } else if (mode === 'check') {
      await runPlan(false);
    } else if (mode === 'download') {
      ui.progress.hidden = false;
      setMode('downloading');
      const res = await frosthold.download.start();
      if (res && res.warnings && res.warnings.length) showWarning(res.warnings.join(' '));
    } else if (mode === 'play') {
      ui.primary.disabled = true;
      await frosthold.game.launch();
    }
  } catch (err) {
    showError(err.message ?? String(err));
    setMode(previo === 'downloading' ? 'download' : previo);
  }
});

ui.stop.addEventListener('click', () => {
  frosthold.download.stop();
  ui.note.textContent = 'Descarga detenida. Continuará desde donde se quedó.';
  setMode('download');
});

async function elegirCarpeta() {
  const dir = await frosthold.install.select();
  if (dir) await useDir(dir);
}

ui.choose.addEventListener('click', async () => {
  try {
    await elegirCarpeta();
  } catch (err) {
    showError(err.message ?? String(err));
  }
});

ui.openDir.addEventListener('click', async () => {
  if (!installDir) return;
  try {
    await frosthold.install.openDir(installDir);
  } catch (err) {
    showError(err.message ?? String(err));
  }
});

ui.verify.addEventListener('click', async () => {
  if (!installDir || mode === 'downloading') return;
  ui.note.className = 'note';
  ui.note.textContent = 'Verificando el cliente archivo por archivo. Esto tarda unos minutos…';
  await runPlan(true);
});

ui.resetGfx.addEventListener('click', async () => {
  if (!installDir) return;
  showError('');
  ui.resetGfx.disabled = true;
  try {
    const res = await frosthold.install.resetGraphics(installDir);
    if (res.cancelled) return;

    ui.note.className = 'note good';
    // Se dice qué se cambió, no solo que se hizo algo: quien llega aquí ya
    // tuvo un problema y necesita saber que esta vez sí pasó lo que esperaba.
    ui.note.textContent = res.removed.length
      ? `Gráficos restablecidos: ventana de 1280x720. Se reemplazaron ${res.removed.length} ajustes de vídeo.`
      : 'Gráficos restablecidos: ventana de 1280x720.';
  } catch (err) {
    showError(err.message ?? String(err));
  } finally {
    ui.resetGfx.disabled = false;
  }
});

// ── Actualización del launcher ──────────────────────────────────────────────

/**
 * Una sola función pinta la barra a partir del estado completo. La alternativa
 * —ir reaccionando a avisos sueltos— deja la interfaz desfasada en cuanto se
 * pierde uno, y aquí se pierde el primero siempre: llega antes de que esta
 * ventana termine de cargar.
 */
function paintUpdate(s) {
  if (!s) return;
  ui.update.dataset.phase = s.phase;
  ui.updateAction.hidden = s.phase !== 'ready';
  ui.checkUpdate.disabled = s.phase === 'checking';

  const textos = {
    checking: 'Buscando una versión nueva del launcher…',
    downloading: `Descargando el launcher ${s.version ?? ''} · ${s.percent}%`,
    ready: `El launcher ${s.version ?? ''} está listo para instalarse.`,
    uptodate: 'El launcher está al día.',
    error: s.message,
    unsupported: s.message,
  };

  const texto = textos[s.phase];
  // En reposo la barra desaparece: no vale la pena gastar una franja de la
  // ventana para decir que no pasa nada.
  ui.update.hidden = !texto || s.phase === 'unsupported';
  ui.updateText.textContent = texto ?? '';

  // «Al día» es una respuesta a una pregunta, no un estado permanente.
  if (s.phase === 'uptodate') {
    clearTimeout(paintUpdate.timer);
    paintUpdate.timer = setTimeout(() => {
      if (ui.update.dataset.phase === 'uptodate') ui.update.hidden = true;
    }, 6000);
  }
}

ui.checkUpdate.addEventListener('click', async () => {
  ui.update.hidden = false;
  ui.updateText.textContent = 'Buscando una versión nueva del launcher…';
  ui.checkUpdate.disabled = true;
  try {
    paintUpdate(await frosthold.updater.check());
  } catch (err) {
    showError(err.message ?? String(err));
  } finally {
    ui.checkUpdate.disabled = false;
  }
});

ui.updateAction.addEventListener('click', async () => {
  showError('');
  ui.updateAction.disabled = true;
  try {
    await frosthold.updater.install();
    ui.updateText.textContent = 'Reiniciando para instalar…';
  } catch (err) {
    // El caso real: hay 16 GB del juego bajando y no conviene cortarlos.
    showError(err.message ?? String(err));
    ui.updateAction.disabled = false;
  }
});

frosthold.on('updater:state', paintUpdate);

$('btn-min').addEventListener('click', () => frosthold.window.minimize());
$('btn-close').addEventListener('click', () => frosthold.window.close());

// ── Eventos del proceso principal ───────────────────────────────────────────

frosthold.on('download:progress', (p) => {
  const pct = p.bytesTotal ? Math.min((p.bytesDone / p.bytesTotal) * 100, 100) : 0;
  ui.barFill.style.width = `${pct}%`;
  ui.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  ui.bar.setAttribute(
    'aria-valuetext',
    `${Math.round(pct)} por ciento, ${bytes(p.bytesDone)} de ${bytes(p.bytesTotal)}`
  );
  ui.progressText.textContent = `${bytes(p.bytesDone)} de ${bytes(p.bytesTotal)} · ${p.filesDone}/${p.filesTotal} archivos`;
  ui.progressSpeed.textContent = p.speed
    ? `${bytes(p.speed)}/s${p.etaSeconds != null ? ` · faltan ${duration(p.etaSeconds)}` : ''}`
    : '';
});

frosthold.on('download:check-progress', (c) => {
  ui.note.textContent = `Verificando archivos… ${c.checked} de ${c.total}`;
});

frosthold.on('download:phase', (phase) => {
  if (phase === 'ready') {
    ui.progress.hidden = true;
    ui.note.className = 'note good';
    ui.note.textContent = 'El cliente está completo y verificado.';
    setMode('play');
  } else if (phase === 'error') {
    setMode('download');
  } else if (phase === 'idle' && mode === 'downloading') {
    setMode('download');
  }
});

frosthold.on('download:retry', (r) => {
  ui.progressSpeed.textContent = `reintentando ${r.path} (${r.attempt})`;
});

frosthold.on('download:error', (msg) => {
  showError(msg);
  setMode('download');
});

frosthold.on('download:warning', (w) => showWarning(w && w.message));
frosthold.on('config:warning', (msg) => showWarning(msg));
frosthold.on('game:error', (msg) => {
  showError(msg);
  if (mode === 'play') setMode('play');
});

frosthold.on('realm:status', (reading) => {
  ultimaLectura = reading;
  paintStatus(reading);
});

// ── Arranque ────────────────────────────────────────────────────────────────

(async () => {
  // Sin este envoltorio, cualquier fallo aquí dejaba la ventana congelada en
  // «Consultando el reino…» con el botón apagado y sin una sola pista.
  try {
    const info = await frosthold.info();
    $('realm-name').textContent = info.realmName;
    $('realm-patch').textContent = info.patch;
    $('app-version').textContent = `v${info.version}`;
    ui.realmlist.textContent = `set realmlist ${info.realmlistHost}`;

    const lectura = await frosthold.realm.status();
    ultimaLectura = lectura;
    paintStatus(lectura);
    // El estado se pide además de escucharse: la primera comprobación puede
    // haber terminado antes de que esta ventana estuviera lista para oírla.
    paintUpdate(await frosthold.updater.state());

    const cfg = await frosthold.config.get();
    if (cfg.installDir) {
      await useDir(cfg.installDir);
    } else {
      setMode('choose');
      ui.note.textContent =
        'Elige dónde quieres el juego. Hacen falta unos 17 GB libres y una carpeta tuya, no «Archivos de programa».';
    }
    ui.primary.focus();
  } catch (err) {
    showError(
      `El launcher no pudo arrancar del todo: ${err?.message ?? err}. Ciérralo y vuelve a abrirlo; si sigue igual, avisa en la comunidad.`
    );
    setMode('choose');
  }
})();

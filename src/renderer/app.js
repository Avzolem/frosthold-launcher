/* global frosthold */
'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  stateDot: $('state-dot'),
  stateLabel: $('state-label'),
  players: $('m-players'),
  accounts: $('m-accounts'),
  uptime: $('m-uptime'),
  path: $('install-path'),
  note: $('client-note'),
  progress: $('progress'),
  barFill: $('bar-fill'),
  progressText: $('progress-text'),
  progressSpeed: $('progress-speed'),
  primary: $('btn-primary'),
  stop: $('btn-stop'),
  choose: $('btn-choose'),
  error: $('error'),
  realmlist: $('realmlist-host'),
  tools: $('tools'),
  openDir: $('btn-open-dir'),
  resetGfx: $('btn-reset-gfx'),
  checkUpdate: $('btn-check-update'),
  update: $('update'),
  updateText: $('update-text'),
  updateAction: $('btn-update'),
};

/** Qué puede hacer el botón grande en cada momento. */
let mode = 'choose'; // choose | check | download | play
let installDir = null;
let pendingBytes = 0;

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
  return `${m} min`;
}

function showError(msg) {
  ui.error.textContent = msg;
  ui.error.hidden = !msg;
}

// ── Estado del reino ────────────────────────────────────────────────────────

function paintStatus(s) {
  if (!s) {
    ui.stateDot.dataset.state = 'unknown';
    ui.stateLabel.textContent = 'Sin datos del reino';
    return;
  }

  ui.stateDot.dataset.state = s.state;
  ui.stateLabel.textContent =
    s.state === 'up'
      ? 'El reino está en línea'
      : s.state === 'down'
        ? 'El reino está caído'
        : 'Sin datos recientes del reino';

  ui.players.textContent = s.playersOnline ?? '—';
  ui.accounts.textContent = s.accounts ?? '—';
  ui.uptime.textContent = s.bootedAt
    ? duration(Math.floor((Date.now() - new Date(s.bootedAt).getTime()) / 1000))
    : '—';
}

// ── Carpeta del juego ───────────────────────────────────────────────────────

async function useDir(dir) {
  installDir = dir;
  ui.path.textContent = dir;
  ui.openDir.disabled = false;
  ui.resetGfx.disabled = false;
  await frosthold.config.set({ installDir: dir });

  const check = await frosthold.install.inspect(dir);
  if (check.ok) {
    ui.note.className = 'note good';
    ui.note.textContent = `Cliente encontrado (${check.executable}, idioma ${check.locale}). Comprobando qué falta…`;
    setMode('check');
    await runPlan();
  } else {
    ui.note.className = 'note';
    ui.note.textContent =
      'Esta carpeta aún no tiene el juego. Se descargará completo, son unos 16,5 GB.';
    setMode('check');
    await runPlan();
  }
}

async function runPlan() {
  showError('');
  try {
    await frosthold.download.manifest();
    const { files, bytes: needed } = await frosthold.download.plan(false);
    pendingBytes = needed;

    if (files === 0) {
      ui.note.className = 'note good';
      ui.note.textContent = 'El cliente está completo y verificado.';
      setMode('play');
    } else {
      ui.note.className = 'note';
      ui.note.textContent = `Faltan ${files} archivos (${bytes(needed)}).`;
      setMode('download');
    }
  } catch (err) {
    showError(err.message ?? String(err));
    setMode('check');
  }
}

// ── Botón principal ─────────────────────────────────────────────────────────

function setMode(next) {
  mode = next;
  ui.primary.disabled = false;
  ui.stop.hidden = true;

  if (next === 'choose') {
    ui.primary.textContent = 'Elige la carpeta del juego';
    ui.primary.disabled = true;
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
  try {
    if (mode === 'check') {
      await runPlan();
    } else if (mode === 'download') {
      ui.progress.hidden = false;
      setMode('downloading');
      await frosthold.download.start();
    } else if (mode === 'play') {
      await frosthold.game.launch();
    }
  } catch (err) {
    showError(err.message ?? String(err));
    setMode(mode === 'downloading' ? 'download' : mode);
  }
});

ui.stop.addEventListener('click', () => {
  frosthold.download.stop();
  setMode('download');
});

ui.choose.addEventListener('click', async () => {
  const dir = await frosthold.install.select();
  if (dir) await useDir(dir);
});

ui.openDir.addEventListener('click', () => {
  if (installDir) frosthold.install.openDir(installDir);
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
  const pct = p.bytesTotal ? (p.bytesDone / p.bytesTotal) * 100 : 0;
  ui.barFill.style.width = `${Math.min(pct, 100)}%`;
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
  }
});

frosthold.on('download:retry', (r) => {
  ui.progressSpeed.textContent = `reintentando ${r.path} (${r.attempt})`;
});

frosthold.on('download:error', (msg) => {
  showError(msg);
  setMode('download');
});

frosthold.on('realm:status', paintStatus);

// ── Arranque ────────────────────────────────────────────────────────────────

(async () => {
  const info = await frosthold.info();
  $('realm-name').textContent = info.realmName;
  $('realm-patch').textContent = info.patch;
  $('app-version').textContent = `v${info.version}`;
  ui.realmlist.textContent = `set realmlist ${info.realmlistHost}`;

  paintStatus(await frosthold.realm.status());
  // El estado se pide además de escucharse: la primera comprobación puede
  // haber terminado antes de que esta ventana estuviera lista para oírla.
  paintUpdate(await frosthold.updater.state());

  const cfg = await frosthold.config.get();
  if (cfg.installDir) {
    await useDir(cfg.installDir);
  } else {
    setMode('choose');
  }
})();

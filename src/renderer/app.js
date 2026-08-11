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
  ui.realmlist.textContent = `set realmlist ${info.realmlistHost}`;

  paintStatus(await frosthold.realm.status());

  const cfg = await frosthold.config.get();
  if (cfg.installDir) {
    await useDir(cfg.installDir);
  } else {
    setMode('choose');
  }
})();

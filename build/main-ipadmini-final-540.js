'use strict';

// 0.5.40: pH-Pruefintervall durchgaengig mit dem Umwaelzpumpen-Zeitplan koppeln.
// Statt 48 festen Uhrzeiten ueber den ganzen Tag werden nur Pruefzeiten innerhalb
// der HEUTE aktiven Pumpenfenster erzeugt. Beispiel 10:30-17:00 bei 30 min:
// 10:30,11:00,...,17:00. Sollwert und restliche Dosierlogik bleiben unveraendert.
const createBase = require('./main-ipadmini-final-539.js');

const VERSION = 'v0.5.40';
const DEFAULT_INTERVAL_MIN = 30;
const DEBUG_ID = 'status.debug.phInterval540';

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function hhmmToMin(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function minToHhmm(total) {
  const value = ((Number(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function todayKey() {
  const day = new Date().getDay(); // 0=So ... 6=Sa
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day];
}

function scheduleAppliesToday(days) {
  const key = todayKey();
  const mode = String(days || 'daily').trim().toLowerCase();
  if (!mode || mode === 'daily') return true;
  if (mode === 'mon_fri') return ['mon', 'tue', 'wed', 'thu', 'fri'].includes(key);
  if (mode === 'sat_sun') return ['sat', 'sun'].includes(key);
  return mode === key;
}

function normalizeWindow(startText, endText) {
  const start = hhmmToMin(startText);
  const end = hhmmToMin(endText);
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

function collectTodayWindows(cfg) {
  const windows = [];
  const schedules = Array.isArray(cfg && cfg.pumpSchedules) ? cfg.pumpSchedules : [];

  for (const row of schedules) {
    if (!row || row.enabled === false || !scheduleAppliesToday(row.days)) continue;
    const window = normalizeWindow(row.start, row.end);
    if (window) windows.push(window);
  }

  if (windows.length) return windows;

  // Fallback fuer alte Konfigurationen ohne pumpSchedules.
  for (const pair of [
    ['pumpWindow1Start', 'pumpWindow1End'],
    ['pumpWindow2Start', 'pumpWindow2End']
  ]) {
    const window = normalizeWindow(cfg && cfg[pair[0]], cfg && cfg[pair[1]]);
    if (window) windows.push(window);
  }
  return windows;
}

function addWindowTimes(target, window, intervalMin) {
  if (!window) return;
  const step = Math.max(5, Math.min(240, Math.round(intervalMin)));

  if (window.end > window.start) {
    for (let t = window.start; t <= window.end; t += step) target.add(minToHhmm(t));
    return;
  }

  // Fenster ueber Mitternacht.
  for (let t = window.start; t < 1440; t += step) target.add(minToHhmm(t));
  for (let t = 0; t <= window.end; t += step) target.add(minToHhmm(t));
}

function buildEffectiveTimes(cfg) {
  const configured = num(cfg && cfg.phCheckIntervalMin);
  const interval = configured !== null && configured >= 5 ? configured : DEFAULT_INTERVAL_MIN;
  const set = new Set();
  for (const window of collectTodayWindows(cfg || {})) addWindowTimes(set, window, interval);
  return {
    interval,
    times: Array.from(set).sort((a, b) => hhmmToMin(a) - hhmmToMin(b))
  };
}

function install(adapter) {
  if (!adapter || adapter.__phInterval540Installed) return adapter;
  adapter.__phInterval540Installed = true;

  // 0.5.39 erzeugt 00:00..23:30. Diese Schicht ersetzt das vor jedem relevanten
  // Schritt wieder durch die aus Pumpenfenstern abgeleitete Liste.
  function applyEffectiveConfig() {
    if (!adapter.config) return { interval: DEFAULT_INTERVAL_MIN, times: [] };
    const effective = buildEffectiveTimes(adapter.config);
    adapter.config.phCheckIntervalMin = effective.interval;
    adapter.config.phDoseLockMinutes = effective.interval;
    adapter.config.phCheckTimes = effective.times.join(',');
    return effective;
  }

  async function ensureDebug() {
    await adapter.setObjectNotExistsAsync(DEBUG_ID, {
      type: 'state',
      common: {
        name: 'pH Intervall und Pumpenfenster 0.5.40',
        type: 'string', role: 'text', read: true, write: false, def: ''
      },
      native: {}
    });
  }

  async function updateDebug(reason) {
    try {
      const effective = applyEffectiveConfig();
      await ensureDebug();
      await adapter.setStateIfChanged(
        DEBUG_ID,
        `AKTIV · ${reason} · Intervall ${effective.interval} min · heutige pH-Zeiten ${effective.times.length ? effective.times.join(',') : 'KEINE (kein aktives Pumpenfenster)'}`,
        true
      );
    } catch {}
  }

  if (typeof adapter.applyControlLogic === 'function') {
    const originalApply = adapter.applyControlLogic.bind(adapter);
    adapter.applyControlLogic = async function applyControlLogicInterval540(...args) {
      applyEffectiveConfig();
      return originalApply(...args);
    };
  }

  // Vor VIS-Build ebenfalls dieselben effektiven Zeiten setzen, damit Anzeige,
  // "naechste Schaltung" und Regelung nicht auseinanderlaufen.
  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      applyEffectiveConfig();
      return patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
    };
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullInterval540(...args) {
      applyEffectiveConfig();
      return originalRender(...args);
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      applyEffectiveConfig();
      await updateDebug('ready');
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
      } catch {}
    }, 300));
  });

  const periodic = setInterval(() => {
    if (!adapter.isShuttingDown) updateDebug('periodisch').catch(() => {});
  }, 5 * 60 * 1000);
  if (typeof adapter.trackInterval === 'function') adapter.trackInterval(periodic);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

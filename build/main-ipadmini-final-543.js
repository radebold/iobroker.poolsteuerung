'use strict';

// 0.5.43: pH-Pruefungen nicht direkt beim Pumpenstart und nicht beim Pumpenende.
// Beispiel Pumpenfenster 10:30-17:00, Intervall 30 min => 11:00..16:30.
// Damit hat das Wasser vor der ersten Bewertung Zeit zur Durchmischung und am
// Abschaltzeitpunkt wird keine Dosierung mehr gestartet.
const createBase = require('./main-ipadmini-final-542.js');

const VERSION = 'v0.5.43';
const DEFAULT_INTERVAL_MIN = 30;

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
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
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
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
  for (const pair of [['pumpWindow1Start','pumpWindow1End'], ['pumpWindow2Start','pumpWindow2End']]) {
    const window = normalizeWindow(cfg && cfg[pair[0]], cfg && cfg[pair[1]]);
    if (window) windows.push(window);
  }
  return windows;
}

function addWindowTimes(target, window, intervalMin) {
  if (!window) return;
  const step = Math.max(5, Math.min(240, Math.round(intervalMin)));

  // Start und Ende werden bewusst ausgeschlossen.
  // Erst nach einem vollen Intervall pruefen; letzter Check muss vor Pumpenende liegen.
  if (window.end > window.start) {
    for (let t = window.start + step; t < window.end; t += step) target.add(minToHhmm(t));
    return;
  }

  // Fenster ueber Mitternacht: Ende rechnerisch in den Folgetag verschieben.
  const endExtended = window.end + 1440;
  for (let t = window.start + step; t < endExtended; t += step) target.add(minToHhmm(t));
}

function buildEffectiveTimes(cfg) {
  const configured = num(cfg && cfg.phCheckIntervalMin);
  const interval = configured !== null && configured >= 5 ? configured : DEFAULT_INTERVAL_MIN;
  const set = new Set();
  for (const window of collectTodayWindows(cfg || {})) addWindowTimes(set, window, interval);
  return { interval, times: Array.from(set).sort((a,b) => hhmmToMin(a) - hhmmToMin(b)) };
}

function applyEffectiveConfig(adapter) {
  if (!adapter || !adapter.config) return { interval: DEFAULT_INTERVAL_MIN, times: [] };
  const effective = buildEffectiveTimes(adapter.config);
  adapter.config.phCheckIntervalMin = effective.interval;
  adapter.config.phDoseLockMinutes = effective.interval;
  adapter.config.phCheckTimes = effective.times.join(',');
  return effective;
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phBoundary543Installed) return adapter;
  adapter.__phBoundary543Installed = true;

  if (typeof adapter.applyControlLogic === 'function') {
    const originalApply = adapter.applyControlLogic.bind(adapter);
    adapter.applyControlLogic = async function applyControlLogicBoundary543(...args) {
      applyEffectiveConfig(adapter);
      return originalApply(...args);
    };
  }

  for (const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      applyEffectiveConfig(adapter);
      return patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
    };
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullBoundary543(...args) {
      applyEffectiveConfig(adapter);
      return originalRender(...args);
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      const effective = applyEffectiveConfig(adapter);
      try {
        await adapter.setObjectNotExistsAsync('status.debug.phBoundary543', {
          type:'state', common:{name:'pH Pruefzeiten ohne Pumpengrenzen 0.5.43',type:'string',role:'text',read:true,write:false,def:''}, native:{}
        });
        await adapter.setStateIfChanged('status.debug.phBoundary543', `AKTIV · ${effective.interval} min · ${effective.times.join(',') || 'keine pH-Pruefzeit'}`, true);
      } catch {}
      try {
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
      } catch {}
    }, 500));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

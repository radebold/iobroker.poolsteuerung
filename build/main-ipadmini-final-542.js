'use strict';

// 0.5.42: pH-Informationen in der VIS kompakter darstellen.
// Regelung und pH-Intervalllogik bleiben unveraendert aus 0.5.41.
const createBase = require('./main-ipadmini-final-541.js');

const VERSION = 'v0.5.42';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function parseTimeToMin(value) {
  const m = String(value || '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function nextPhCheck(adapter) {
  const raw = String((adapter.config && adapter.config.phCheckTimes) || '');
  const times = raw.split(',').map(v => v.trim()).filter(Boolean);
  if (!times.length) return '--';

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const time of times) {
    const min = parseTimeToMin(time);
    if (min !== null && min >= nowMin) return time;
  }
  return times[0];
}

function compactPhSchedule(adapter) {
  const interval = Number(adapter.config && adapter.config.phCheckIntervalMin);
  const intervalMin = Number.isFinite(interval) && interval > 0 ? interval : 30;
  const next = nextPhCheck(adapter);
  return next === '--'
    ? `alle ${intervalMin} Min · heute kein weiterer Check`
    : `alle ${intervalMin} Min · nächster Check ${next} Uhr`;
}

function sameLocalDay(day, month, year) {
  const now = new Date();
  return now.getDate() === Number(day) &&
    now.getMonth() + 1 === Number(month) &&
    now.getFullYear() === Number(year);
}

function compactDoseText(text) {
  // Beispiel bisher: 180 s / 31 ml · 6.8.2026, 19:12:58
  return String(text || '').replace(
    /(\d+)\s*s\s*\/\s*([\d.,]+)\s*ml\s*·\s*(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s*(\d{1,2}):(\d{2})(?::\d{2})?/g,
    (_all, sec, ml, day, month, year, hour, minute) => {
      const hh = String(hour).padStart(2, '0');
      const when = sameLocalDay(day, month, year)
        ? `heute ${hh}:${minute} Uhr`
        : `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}. ${hh}:${minute} Uhr`;
      return `${ml} ml · ${sec} s · ${when}`;
    }
  );
}

function patchPhInfo(adapter, value) {
  let text = patchVersion(value);
  if (!text) return text;

  // Technische Tagesliste durch eine kompakte, nutzerrelevante Angabe ersetzen.
  const rawTimes = String((adapter.config && adapter.config.phCheckTimes) || '').trim();
  if (rawTimes) text = text.split(rawTimes).join(compactPhSchedule(adapter));

  text = text.replace(/pH Zeiten/g, 'pH Prüfung');
  text = compactDoseText(text);
  return text;
}

function install(adapter) {
  if (!adapter || adapter.__compactPhVis542Installed) return adapter;
  adapter.__compactPhVis542Installed = true;

  const originalSetStateIfChanged = adapter.setStateIfChanged.bind(adapter);

  async function patchExistingVisStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        if (!current) continue;
        const next = patchPhInfo(adapter, current);
        if (next !== current) await originalSetStateIfChanged(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) {
          adapter.log.error(`[VIS-PH-KOMPAKT 0.5.42] ${id}: ${error.message || error}`);
        }
      }
    }
  }

  // Builder-Ausgaben direkt kompakt erzeugen.
  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchPhInfo(adapter, original({ ...(data || {}), adapterVersion: VERSION }));
  }

  // Nach regulaeren Vollrenders nur die bereits erzeugten States textlich nachziehen.
  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullCompactPh542(...args) {
      const result = await originalRender(...args);
      await patchExistingVisStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      await patchExistingVisStates();
    }, 1200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

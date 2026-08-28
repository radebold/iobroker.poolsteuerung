'use strict';

// 0.5.63: Mehr Betriebsinformationen in der bestehenden Phone-VIS.
// WICHTIG: keine neuen HTML-Container, keine CSS-/Groessen-/Hoehenaenderungen.
// Es werden ausschliesslich vorhandene Textstellen ersetzt.
const createBase = require('./main-ipadmini-final-562.js');
const VERSION = 'v0.5.63';
const PHONE_IDS = ['vis.htmlPhone', 'vis.widgetPhone'];

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function hhmmToMin(v) {
  const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? h * 60 + mi : null;
}

function dayKey() {
  return ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];
}

function appliesToday(days) {
  const d = dayKey();
  const mode = String(days || 'daily').trim().toLowerCase();
  if (!mode || mode === 'daily') return true;
  if (mode === 'mon_fri') return ['mon','tue','wed','thu','fri'].includes(d);
  if (mode === 'sat_sun') return ['sat','sun'].includes(d);
  return mode === d;
}

function pumpWindows(cfg) {
  const out = [];
  const schedules = Array.isArray(cfg && cfg.pumpSchedules) ? cfg.pumpSchedules : [];
  for (const row of schedules) {
    if (!row || row.enabled === false || !appliesToday(row.days)) continue;
    const s = String(row.start || '').trim();
    const e = String(row.end || '').trim();
    if (hhmmToMin(s) !== null && hhmmToMin(e) !== null && s !== e) out.push(`${s}–${e}`);
  }
  if (out.length) return out;
  for (const [a,b] of [['pumpWindow1Start','pumpWindow1End'],['pumpWindow2Start','pumpWindow2End']]) {
    const s = String((cfg && cfg[a]) || '').trim();
    const e = String((cfg && cfg[b]) || '').trim();
    if (hhmmToMin(s) !== null && hhmmToMin(e) !== null && s !== e) out.push(`${s}–${e}`);
  }
  return out;
}

function shortLastDoseFromTablet(html) {
  const text = String(html || '');

  // Aktueller kompakter Tablet-Text, z.B. "9 ml · 51 s · 17.08. 12:31 Uhr"
  let m = text.match(/([\d.,]+)\s*ml\s*·\s*(\d+)\s*s\s*·\s*(?:heute\s+)?(?:(\d{1,2})\.(\d{1,2})\.\s*)?(\d{1,2}):(\d{2})\s*Uhr/i);
  if (m) {
    const ml = m[1];
    const sec = m[2];
    const date = m[3] && m[4] ? `${String(m[3]).padStart(2,'0')}.${String(m[4]).padStart(2,'0')}. ` : 'heute ';
    return `${date}${String(m[5]).padStart(2,'0')}:${m[6]} · ${ml}ml/${sec}s`;
  }

  // Aelteres Format, z.B. "180 s / 31 ml · 6.8.2026, 19:12:58"
  m = text.match(/(\d+)\s*s\s*\/\s*([\d.,]+)\s*ml\s*·\s*(\d{1,2})\.(\d{1,2})\.\d{4},?\s*(\d{1,2}):(\d{2})/i);
  if (m) return `${String(m[3]).padStart(2,'0')}.${String(m[4]).padStart(2,'0')}. ${String(m[5]).padStart(2,'0')}:${m[6]} · ${m[2]}ml/${m[1]}s`;

  return '';
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function patchPhoneText(html, info) {
  let out = patchVersion(html);
  if (!out) return out;

  // Nur Text ersetzen. Keine Tags, Styles oder Container anfassen.
  if (info.lastDose) {
    out = out.replace(/Letzte:\s*(?:\([^<]{0,90}\)|[^<]{0,90})/i, `Letzte: ${info.lastDose}`);
  }

  const interval = Number(info.intervalMin);
  if (Number.isFinite(interval) && interval > 0) {
    out = out.replace(/Nächste:\s*([^<]{1,80}?)(?=<)/i, (_all, value) => {
      const clean = String(value || '').replace(/\s*·\s*\d+\s*Min\.?\s*$/i, '').trim();
      return `Nächste: ${clean} · ${Math.round(interval)} Min.`;
    });
  }

  if (info.pumpWindow) {
    // Dieses Feld war in der Phone-VIS bislang ohne nutzbaren Wert.
    // Die Ersetzung aendert nur den Labeltext und damit keinerlei Layoutgroesse.
    out = out.replace(/Poolwert von/gi, `Umwälzung ${info.pumpWindow}`);
  }

  return out;
}

function install(adapter) {
  if (!adapter || adapter.__phoneInfo563Installed) return adapter;
  adapter.__phoneInfo563Installed = true;

  const writer = typeof adapter.setStateIfChanged === 'function'
    ? adapter.setStateIfChanged.bind(adapter)
    : null;
  let busy = false;
  let timer = null;

  async function patchPhoneStates() {
    if (!writer || busy || adapter.isShuttingDown) return;
    busy = true;
    try {
      const tablet = await adapter.getStateAsync('vis.htmlTablet');
      const lastDose = shortLastDoseFromTablet(tablet && tablet.val);
      const windows = pumpWindows(adapter.config || {});
      const info = {
        lastDose,
        intervalMin: num(adapter.config && adapter.config.phCheckIntervalMin) || 30,
        pumpWindow: windows.length ? windows.join(' / ') : '--'
      };

      for (const id of PHONE_IDS) {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        if (!current) continue;
        const next = patchPhoneText(current, info);
        if (next !== current) await writer(id, next, true);
      }
    } catch (e) {
      if (!adapter.isDbClosedError || !adapter.isDbClosedError(e)) {
        if (adapter.log && typeof adapter.log.debug === 'function') adapter.log.debug(`[PHONE-INFO 0.5.63] ${e.message || e}`);
      }
    } finally {
      busy = false;
    }
  }

  function schedulePatch(delay = 120) {
    if (timer || adapter.isShuttingDown) return;
    timer = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(timer); } catch {}
      timer = null;
      await patchPhoneStates();
    }, delay));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const original = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullPhoneInfo563(...args) {
      const result = await original(...args);
      await patchPhoneStates();
      return result;
    };
  }

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown) return;
    const local = String(id || '').replace(`${adapter.namespace}.`, '');
    if (local === 'vis.htmlPhone' || local === 'vis.widgetPhone' || local === 'vis.htmlTablet') schedulePatch(150);
  });

  adapter.on('ready', () => schedulePatch(1400));
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

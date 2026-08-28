'use strict';

// 0.5.69: stabile 0.5.68-Phone-VIS beibehalten.
// Nur die fehlende 24h-Pooltemperaturkurve wird nach dem Rendern direkt
// in vis.htmlPhone / vis.widgetPhone eingesetzt. Keine Aenderung an
// vis.htmlIpadMini, keine Runtime-DOM-Manipulation, keine Gesamtgroessenaenderung.
const createBase = require('./main-ipadmini-final-568.js');
const VERSION = 'v0.5.69';
const PHONE_IDS = ['vis.htmlPhone', 'vis.widgetPhone'];
const LOCAL24H_ID = 'status.trend.ipadMiniLocal24hJson';
const POOL24H_ID = 'status.trend.poolTemp24hJson';

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function parseJson(v, fallback) {
  try { return JSON.parse(String(v || '')); } catch { return fallback; }
}
function normalizeRows(rows) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : [])
    .map(r => ({ ts: Number(r && r.ts), val: num(r && (r.val !== undefined ? r.val : r)) }))
    .filter(r => Number.isFinite(r.ts) && r.val !== null && r.ts >= start && r.ts <= now)
    .sort((a,b) => a.ts - b.ts);
}
function buildSvg(rows) {
  let a = normalizeRows(rows);
  if (a.length < 2) return '';
  if (a.length > 96) {
    const s = [];
    for (let i = 0; i < 96; i++) s.push(a[Math.round(i * (a.length - 1) / 95)]);
    a = s;
  }
  const vals = a.map(r => r.val);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const visible = Math.max(0.6, hi - lo);
  const center = (lo + hi) / 2;
  const min = center - visible * 0.62, max = center + visible * 0.62;
  const t0 = a[0].ts, t1 = a[a.length - 1].ts;
  const tr = Math.max(1, t1 - t0), vr = Math.max(0.001, max - min);
  const W = 160, H = 30;
  const rnd = n => Math.round(n * 10) / 10;
  const x = ts => 2 + ((ts - t0) / tr) * 156;
  const y = v => 3 + (1 - ((v - min) / vr)) * 24;
  const path = a.map((r,i) => `${i ? 'L' : 'M'}${rnd(x(r.ts))} ${rnd(y(r.val))}`).join(' ');
  const last = a[a.length - 1];
  return `<svg class="phone-temp24-569" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="${rnd(x(last.ts))}" cy="${rnd(y(last.val))}" r="1.5" fill="currentColor"></circle></svg>`;
}
function patchVersion(html) {
  return String(html || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}
function inject(html, svg) {
  let out = patchVersion(html);
  if (!out || !svg) return out;
  out = out.replace(/<style data-phone-temp-569="1">[\s\S]*?<\/style>/g, '');
  const css = `<style data-phone-temp-569="1">.temp-inline-569{height:30px;min-width:96px;max-width:165px;flex:1 1 130px;margin-left:auto;overflow:hidden;color:#39aef7;align-self:center;pointer-events:none}.temp-inline-569 .phone-temp24-569{display:block;width:100%!important;height:30px!important;overflow:hidden}</style>`;
  if (out.includes('</head>')) out = out.replace('</head>', css + '</head>');
  else out = css + out;

  // Falls ein frueher 568-Platzhalter existiert, ersetzen statt verdoppeln.
  out = out.replace(/<div class="temp-inline-568">[\s\S]*?<\/div>/g, '');
  out = out.replace(/<div class="temp-inline-569">[\s\S]*?<\/div>/g, '');

  let done = false;
  out = out.replace(/(<div class="temp-row">\s*<div class="temp">[\s\S]*?<\/div>\s*<div class="unit">[\s\S]*?<\/div>)(\s*<\/div>)/i, (_m,a,b) => {
    done = true;
    return `${a}<div class="temp-inline-569">${svg}</div>${b}`;
  });
  if (!done) {
    out = out.replace(/(<div class="ps-tempRow">\s*<div class="ps-temp">[\s\S]*?<\/div>\s*<div class="ps-unit">[\s\S]*?<\/div>)(\s*<\/div>)/i, (_m,a,b) => `${a}<div class="temp-inline-569">${svg}</div>${b}`);
  }
  return out;
}

function install(adapter) {
  if (!adapter || adapter.__phone569Installed) return adapter;
  adapter.__phone569Installed = true;
  let busy = false;

  async function getSvg() {
    let rows = [];
    try {
      const s = await adapter.getStateAsync(LOCAL24H_ID);
      const obj = parseJson(s && s.val, {});
      if (obj && Array.isArray(obj.water)) rows = obj.water;
    } catch {}
    if (normalizeRows(rows).length < 2) {
      try {
        const s = await adapter.getStateAsync(POOL24H_ID);
        const arr = parseJson(s && s.val, []);
        if (Array.isArray(arr)) rows = arr;
      } catch {}
    }
    try {
      const id = String((adapter.config && adapter.config.waterTempStateId) || '').trim();
      if (id) {
        const s = await adapter.getForeignStateAsync(id);
        const v = num(s && s.val);
        if (v !== null) rows = [...normalizeRows(rows), { ts: Date.now(), val: v }];
      }
    } catch {}
    return buildSvg(rows);
  }

  async function patchPhoneStates() {
    if (busy || adapter.isShuttingDown) return;
    busy = true;
    try {
      const svg = await getSvg();
      for (const id of PHONE_IDS) {
        try {
          const s = await adapter.getStateAsync(id);
          const cur = String((s && s.val) || '');
          if (!cur) continue;
          const next = inject(cur, svg);
          if (next !== cur) {
            if (typeof adapter.setStateIfChanged === 'function') await adapter.setStateIfChanged(id, next, true);
            else await adapter.setStateAsync(id, next, true);
          }
        } catch {}
      }
    } finally {
      busy = false;
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const original = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFull569(...args) {
      const result = await original(...args);
      await patchPhoneStates();
      return result;
    };
  }
  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(h); } catch {}
      if (!adapter.isShuttingDown) await patchPhoneStates();
    }, 1600));
  });
  return adapter;
}
function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

// 0.5.75: isolierter 24h-Pooltemperatur-Fix auf Basis der stabilen 0.5.74.
// Die Kurve wird am finalen Phone-VIS-Schreibpunkt direkt aus history.0 erzeugt.
// Keine Aenderung an Kartenhoehe, Seitenhoehe, Regelung oder Versionsbesitz.
const createBase = require('./main-ipadmini-final-574.js');

const VERSION = 'v0.5.75';
const PHONE_IDS = new Set(['vis.htmlPhone', 'vis.widgetPhone']);
const CACHE_MS = 60000;

function localId(adapter, id) {
  const s = String(id || '');
  const p = `${adapter.namespace}.`;
  return s.startsWith(p) ? s.slice(p.length) : s;
}

function normalizeVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function cleanOldCurve(html) {
  let out = String(html || '');
  out = out.replace(/<style data-phone-temp-(?:568|569|570|571|572|573|575)="1">[\s\S]*?<\/style>/g, '');
  out = out.replace(/<div class="(?:temp-inline-(?:568|569|570)|ps-temp-inline-(?:571|572)|phone-temp-inline-(?:572|573)|phone-temp-inline-575)">[\s\S]*?<\/div>/g, '');
  return out;
}

function injectCurve(html, svg) {
  let out = normalizeVersion(cleanOldCurve(html));
  const curve = String(svg || '').trim();
  if (!out || !curve.includes('<svg')) return { html: out, inserted: false, reason: 'kein SVG' };

  const css = `<style data-phone-temp-575="1">
.phone-temp-inline-575{position:relative;height:32px;flex:1 1 120px;min-width:90px;max-width:170px;margin-left:12px;overflow:hidden;color:#76d7ff;align-self:center;pointer-events:none}
.phone-temp-inline-575 svg,.phone-temp-inline-575 .sparkline{display:block!important;width:100%!important;max-width:none!important;height:32px!important;overflow:hidden!important}
.phone-temp-inline-575 path{fill:none!important;stroke:#76d7ff!important;stroke-width:1!important;stroke-linecap:round!important;stroke-linejoin:round!important}
.phone-temp-inline-575 circle{fill:#76d7ff!important;stroke:none!important}
</style>`;
  if (out.includes('</head>')) out = out.replace('</head>', css + '</head>');
  else out = css + out;

  let inserted = false;
  out = out.replace(
    /(<div class="temp-row">\s*<div class="temp">[\s\S]*?<\/div>\s*<div class="unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
    (_m, a, b) => { inserted = true; return `${a}<div class="phone-temp-inline-575">${curve}</div>${b}`; }
  );
  if (!inserted) {
    out = out.replace(
      /(<div class="ps-tempRow">\s*<div class="ps-temp">[\s\S]*?<\/div>\s*<div class="ps-unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
      (_m, a, b) => { inserted = true; return `${a}<div class="phone-temp-inline-575">${curve}</div>${b}`; }
    );
  }
  return { html: out, inserted, reason: inserted ? 'OK' : 'Temperaturzeile nicht gefunden' };
}

function install(adapter) {
  if (!adapter || adapter.__phoneTemp575Installed) return adapter;
  adapter.__phoneTemp575Installed = true;

  const previousSetStateAsync = adapter.setStateAsync.bind(adapter);
  let cache = { ts: 0, svg: '', count: 0, source: '', error: '' };
  let loading = null;
  let lastInsert = 'noch kein Phone-Write';

  async function loadCurve(force = false) {
    const now = Date.now();
    if (!force && cache.svg && now - cache.ts < CACHE_MS) return cache;
    if (loading) return loading;
    loading = (async () => {
      const stateId = String((adapter.config && adapter.config.waterTempStateId) || '').trim();
      const historyInstance = String((adapter.config && adapter.config.trendHistoryInstance) || 'history.0').trim() || 'history.0';
      const next = { ts: Date.now(), svg: '', count: 0, source: `${historyInstance} · ${stateId || 'kein waterTempStateId'}`, error: '' };
      try {
        if (!stateId) throw new Error('waterTempStateId ist leer');
        if (typeof adapter.fetchHistoryValues !== 'function') throw new Error('fetchHistoryValues nicht verfuegbar');
        if (typeof adapter.buildSparklineSvgFromValues !== 'function') throw new Error('buildSparklineSvgFromValues nicht verfuegbar');
        const end = Date.now();
        const values = await Promise.race([
          adapter.fetchHistoryValues(stateId, end - 24 * 60 * 60 * 1000, end, 'average', 96),
          new Promise(resolve => setTimeout(() => resolve([]), 8000))
        ]);
        next.count = Array.isArray(values) ? values.length : 0;
        if (next.count) next.svg = String(adapter.buildSparklineSvgFromValues(values, 'sparkline-temp', '24h') || '');
        if (!next.count) next.error = 'History lieferte 0 Werte';
        else if (!next.svg.includes('<svg')) next.error = 'Historywerte vorhanden, aber SVG leer';
      } catch (e) {
        next.error = String((e && e.message) || e || 'unbekannter Fehler');
      }
      cache = next;
      return cache;
    })().finally(() => { loading = null; });
    return loading;
  }

  adapter.setStateAsync = async function setStateAsync575(id, value, ack, ...rest) {
    const local = localId(adapter, id);
    if (PHONE_IDS.has(local) && typeof value === 'string') {
      const curve = await loadCurve(false);
      const patched = injectCurve(value, curve.svg);
      lastInsert = patched.inserted ? `eingefuegt · ${curve.count} Werte` : `${patched.reason} · ${curve.count} Werte`;
      return previousSetStateAsync(id, patched.html, ack, ...rest);
    }
    return previousSetStateAsync(id, value, ack, ...rest);
  };

  async function ensureDiag() {
    const defs = {
      'status.debug.phoneTemp575': { name:'Phone Temperaturkurve 0.5.75', type:'string' },
      'status.debug.phoneTemp575HistoryCount': { name:'Phone Temperaturkurve History-Werte', type:'number' },
      'status.debug.phoneTemp575Source': { name:'Phone Temperaturkurve Quelle', type:'string' }
    };
    for (const [id, d] of Object.entries(defs)) {
      await adapter.setObjectNotExistsAsync(id, { type:'state', common:{name:d.name,type:d.type,role:d.type==='number'?'value':'text',read:true,write:false,def:d.type==='number'?0:''}, native:{} });
    }
  }

  async function publishDiag() {
    try {
      await ensureDiag();
      await previousSetStateAsync('status.debug.phoneTemp575', `${lastInsert}${cache.error ? ' · ' + cache.error : ''}`, true);
      await previousSetStateAsync('status.debug.phoneTemp575HistoryCount', cache.count || 0, true);
      await previousSetStateAsync('status.debug.phoneTemp575Source', cache.source || '', true);
    } catch {}
  }

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(h); } catch {}
      if (adapter.isShuttingDown) return;
      await loadCurve(true);
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.renderVisFull === 'function') await adapter.renderVisFull(true);
      } catch {}
      await publishDiag();
      const timer = setInterval(async () => {
        if (adapter.isShuttingDown) return;
        await loadCurve(true);
        await publishDiag();
      }, 60000);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(timer);
    }, 2400));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

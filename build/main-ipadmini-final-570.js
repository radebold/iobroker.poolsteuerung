'use strict';

// 0.5.70: finaler Phone-VIS-Writer.
// Ursache: die alte 0.5.51-Schicht patcht in setStateIfChanged() jeden String
// wieder auf v0.5.51. Fuer die beiden Phone-VIS-States wird dieser Legacy-Writer
// gezielt umgangen. Die 24h-Pooltemperaturkurve kommt direkt aus den bereits
// vorhandenen History-Funktionen des Basisadapters.
const createBase = require('./main-ipadmini-final-568.js');
const VERSION = 'v0.5.70';
const PHONE_IDS = new Set(['vis.htmlPhone', 'vis.widgetPhone']);

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function injectCurve(html, svg) {
  let out = patchVersion(html);
  if (!out) return out;

  // Alte 568-Inline-Kurve entfernen, damit niemals doppelt gerendert wird.
  out = out.replace(/<div class="temp-inline-568">[\s\S]*?<\/div>/g, '');
  out = out.replace(/<div class="temp-inline-570">[\s\S]*?<\/div>/g, '');
  out = out.replace(/<style data-phone-temp-570="1">[\s\S]*?<\/style>/g, '');

  if (!svg) return out;

  const css = `<style data-phone-temp-570="1">\n.temp-inline-570{height:32px;min-width:96px;max-width:170px;flex:1 1 130px;margin-left:auto;overflow:hidden;color:#39aef7;align-self:center;pointer-events:none}\n.temp-inline-570 svg,.temp-inline-570 .sparkline{display:block!important;width:100%!important;height:32px!important;max-width:none!important;overflow:hidden!important}\n.temp-inline-570 path{stroke-width:1!important}\n</style>`;
  if (out.includes('</head>')) out = out.replace('</head>', css + '</head>');
  else out = css + out;

  let inserted = false;
  out = out.replace(
    /(<div class="temp-row">\s*<div class="temp">[\s\S]*?<\/div>\s*<div class="unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
    (_m, a, b) => {
      inserted = true;
      return `${a}<div class="temp-inline-570">${svg}</div>${b}`;
    }
  );

  if (!inserted) {
    out = out.replace(
      /(<div class="ps-tempRow">\s*<div class="ps-temp">[\s\S]*?<\/div>\s*<div class="ps-unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
      (_m, a, b) => `${a}<div class="temp-inline-570">${svg}</div>${b}`
    );
  }
  return out;
}

function install(adapter) {
  if (!adapter || adapter.__phone570Installed) return adapter;
  adapter.__phone570Installed = true;

  let currentSvg = '';
  let refreshPromise = null;

  async function refreshSvg() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      let svg = '';

      // 1. Primaer: bereits vorhandene History-Sparkline-Funktion des Basisadapters.
      try {
        if (typeof adapter.getHistorySparklines === 'function') {
          const data = await Promise.race([
            adapter.getHistorySparklines(),
            new Promise(resolve => setTimeout(() => resolve(null), 10000))
          ]);
          if (data && data.poolTempSparklineSvg) svg = String(data.poolTempSparklineSvg);
        }
      } catch {}

      // 2. Fallback: lokaler Trendcache.
      if (!svg) {
        try {
          if (typeof adapter.getLocalTrendSparklines === 'function') {
            const data = await adapter.getLocalTrendSparklines();
            if (data && data.poolTempSparklineSvg) svg = String(data.poolTempSparklineSvg);
          }
        } catch {}
      }

      // 3. Letzter Fallback: History direkt lesen und mit der vorhandenen
      // Sparkline-Funktion zeichnen.
      if (!svg) {
        try {
          if (typeof adapter.fetchHistoryValues === 'function' &&
              typeof adapter.buildSparklineSvgFromValues === 'function' &&
              adapter.config && adapter.config.waterTempStateId) {
            const now = Date.now();
            const values = await adapter.fetchHistoryValues(
              adapter.config.waterTempStateId,
              now - 24 * 60 * 60 * 1000,
              now,
              'average',
              96
            );
            svg = String(adapter.buildSparklineSvgFromValues(values, 'sparkline-temp', '24h') || '');
          }
        } catch {}
      }

      currentSvg = svg;
      return currentSvg;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  // WICHTIG: dies ist der eigentliche Fix fuer die sichtbare v0.5.51.
  // Phone-HTML wird direkt geschrieben und damit NICHT mehr durch den
  // alten 0.5.51-setStateIfChanged-Wrapper geschickt.
  const legacySetStateIfChanged = typeof adapter.setStateIfChanged === 'function'
    ? adapter.setStateIfChanged.bind(adapter)
    : null;

  adapter.setStateIfChanged = async function setStateIfChanged570(id, value, ack = true, ...rest) {
    if (PHONE_IDS.has(String(id)) && typeof value === 'string') {
      const next = injectCurve(value, currentSvg);
      const cur = await adapter.getStateAsync(id);
      if (cur && cur.val === next) return false;
      await adapter.setStateAsync(id, next, ack);
      return true;
    }
    if (legacySetStateIfChanged) return legacySetStateIfChanged(id, value, ack, ...rest);
    await adapter.setStateAsync(id, value, ack);
    return true;
  };

  async function patchExistingPhoneStates() {
    for (const id of PHONE_IDS) {
      try {
        const state = await adapter.getStateAsync(id);
        const cur = String((state && state.val) || '');
        if (!cur) continue;
        const next = injectCurve(cur, currentSvg);
        if (next !== cur) await adapter.setStateAsync(id, next, true);
      } catch {}
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const original = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFull570(...args) {
      await refreshSvg();
      const result = await original(...args);
      await patchExistingPhoneStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(h); } catch {}
      if (adapter.isShuttingDown) return;
      await refreshSvg();
      await patchExistingPhoneStates();
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.renderVisFull === 'function') await adapter.renderVisFull(true);
      } catch {}
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

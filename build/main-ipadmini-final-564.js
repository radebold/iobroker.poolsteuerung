'use strict';

// 0.5.64: Phone-VIS ohne Groessenaenderung.
// - PH-Info/Flag rechtsbuendig.
// - vorhandenen Pooltemperatur-24h-Sparkline-Bereich mit lokalen 24h-Daten fuellen.
const createBase = require('./main-ipadmini-final-563.js');
const VERSION = 'v0.5.64';
const LOCAL24H_ID = 'status.trend.ipadMiniLocal24hJson';
const POOL24H_ID = 'status.trend.poolTemp24hJson';

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeRows(rows) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : [])
    .map(r => ({ ts: Number(r && r.ts), val: num(r && (r.val !== undefined ? r.val : r)) }))
    .filter(r => Number.isFinite(r.ts) && r.val !== null && r.ts >= start && r.ts <= now)
    .sort((a,b) => a.ts - b.ts);
}

function buildTempSvg(rows) {
  let values = normalizeRows(rows);
  if (values.length < 2) return '';
  if (values.length > 96) {
    const sampled = [];
    for (let i = 0; i < 96; i++) sampled.push(values[Math.round(i * (values.length - 1) / 95)]);
    values = sampled;
  }

  const nums = values.map(r => r.val);
  const actualMin = Math.min(...nums);
  const actualMax = Math.max(...nums);
  const visibleRange = Math.max(0.6, actualMax - actualMin);
  const center = (actualMin + actualMax) / 2;
  const min = center - visibleRange * 0.62;
  const max = center + visibleRange * 0.62;
  const firstTs = values[0].ts;
  const lastTs = values[values.length - 1].ts;
  const timeRange = Math.max(1, lastTs - firstTs);
  const valRange = Math.max(0.001, max - min);
  const width = 160, height = 28, px = 2, py = 3;
  const round = v => Math.round(v * 10) / 10;
  const x = ts => px + ((ts - firstTs) / timeRange) * (width - 2 * px);
  const y = val => py + (1 - ((val - min) / valRange)) * (height - 2 * py);
  const path = values.map((r,i) => `${i ? 'L' : 'M'}${round(x(r.ts))} ${round(y(r.val))}`).join(' ');
  const last = values[values.length - 1];
  return `<svg class="sparkline sparkline-temp" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="${round(x(last.ts))}" cy="${round(y(last.val))}" r="1.5" fill="currentColor"></circle></svg>`;
}

function patchVersion(html) {
  return String(html || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function injectCss(html) {
  let out = String(html || '');
  if (!out || out.includes('data-phone-layout-564="1"')) return out;
  const css = `<style data-phone-layout-564="1">\n/* nur Ausrichtung, keine Hoehen-/Breitenaenderung der VIS */\n.ph-wa-flag{width:max-content!important;max-width:100%!important;margin-left:auto!important;margin-right:0!important;align-self:flex-end!important;justify-self:end!important}\n</style>`;
  return out.includes('</head>') ? out.replace('</head>', `${css}</head>`) : css + out;
}

function injectTempSvg(html, svg) {
  let out = String(html || '');
  if (!out || !svg) return out;

  // Phone-Widget / aktuelle Phone-VIS: vorhandenen, leeren Bereich nutzen.
  out = out.replace(/<div class="ps-temp-spark">\s*<\/div>/g, `<div class="ps-temp-spark">${svg}</div>`);
  // Aeltere Phone-HTML-Variante: ebenfalls vorhandenen Bereich nutzen.
  out = out.replace(/<div class="temp-history-24h">\s*<\/div>/g, `<div class="temp-history-24h">${svg}</div>`);

  return out;
}

function patchPhone(html, svg) {
  return injectTempSvg(injectCss(patchVersion(html)), svg);
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function install(adapter) {
  if (!adapter || adapter.__phoneLayout564Installed) return adapter;
  adapter.__phoneLayout564Installed = true;
  adapter.__phoneTempSvg564 = '';
  adapter.__phoneTempRefresh564 = null;

  async function refreshTempSvg() {
    if (adapter.__phoneTempRefresh564) return adapter.__phoneTempRefresh564;
    adapter.__phoneTempRefresh564 = (async () => {
      let rows = [];
      try {
        const local = await adapter.getStateAsync(LOCAL24H_ID);
        const parsed = parseJson(local && local.val, {});
        if (parsed && Array.isArray(parsed.water)) rows = parsed.water;
      } catch {}
      if (normalizeRows(rows).length < 2) {
        try {
          const state = await adapter.getStateAsync(POOL24H_ID);
          const parsed = parseJson(state && state.val, []);
          if (Array.isArray(parsed)) rows = parsed;
        } catch {}
      }
      // aktuellen Messwert anhaengen, damit die Linie am aktuellen Wert endet
      try {
        const id = String((adapter.config && adapter.config.waterTempStateId) || '').trim();
        if (id) {
          const s = await adapter.getForeignStateAsync(id);
          const v = num(s && s.val);
          if (v !== null) rows = [...normalizeRows(rows), { ts: Date.now(), val: v }];
        }
      } catch {}
      adapter.__phoneTempSvg564 = buildTempSvg(rows);
      return adapter.__phoneTempSvg564;
    })().finally(() => { adapter.__phoneTempRefresh564 = null; });
    return adapter.__phoneTempRefresh564;
  }

  for (const name of ['buildPhoneHtml','buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchPhone(original({ ...(data || {}), adapterVersion: VERSION }), adapter.__phoneTempSvg564 || '');
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFull564(...args) {
      await refreshTempSvg();
      return originalRender(...args);
    };
  }

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(h); } catch {}
      if (adapter.isShuttingDown) return;
      await refreshTempSvg();
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.renderVisFull === 'function') await adapter.renderVisFull(true);
      } catch {}
    }, 1500));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

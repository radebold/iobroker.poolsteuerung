'use strict';

const createFastAdapter = require('./main-fast.js');

const ADAPTER_VERSION = 'v0.4.5';
const PH_WEIGHT_STATE_ID = 'mqtt.0.pool.phminus.waage.weight_kg';
const PH_CANISTER_TARE_KG = 0.500;
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_CACHE_MS = 5 * 60 * 1000;

function numberValue(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildNetWeightSparkline(values) {
  let rows = (Array.isArray(values) ? values : [])
    .map(row => ({
      ts: Number(row && row.ts),
      val: numberValue(row && row.val !== undefined ? row.val : row)
    }))
    .filter(row => Number.isFinite(row.ts) && Number.isFinite(row.val))
    .sort((a, b) => a.ts - b.ts);

  if (!rows.length) return '';

  // Doppelte Zeitpunkte entfernen und den jeweils letzten Wert behalten.
  const deduplicated = [];
  for (const row of rows) {
    const previous = deduplicated[deduplicated.length - 1];
    if (previous && previous.ts === row.ts) previous.val = row.val;
    else deduplicated.push({ ...row });
  }
  rows = deduplicated;

  if (rows.length === 1) {
    rows.unshift({ ts: rows[0].ts - 60000, val: rows[0].val });
  }

  const maxPoints = 96;
  if (rows.length > maxPoints) {
    const sampled = [];
    for (let index = 0; index < maxPoints; index++) {
      sampled.push(rows[Math.round(index * (rows.length - 1) / (maxPoints - 1))]);
    }
    rows = sampled;
  }

  const numbers = rows.map(row => row.val);
  let min = Math.min(...numbers);
  let max = Math.max(...numbers);
  const rawRange = max - min;

  if (rawRange < 0.001) {
    min -= 0.025;
    max += 0.025;
  } else {
    const visibleRange = Math.max(rawRange, 0.050);
    const center = (min + max) / 2;
    min = center - visibleRange / 2;
    max = center + visibleRange / 2;
    const margin = (max - min) * 0.12;
    min -= margin;
    max += margin;
  }

  const width = 160;
  const height = 24;
  const padX = 2;
  const padY = 3;
  const round = value => Math.round(value * 10) / 10;
  const toX = index => padX + (index / Math.max(1, rows.length - 1)) * (width - 2 * padX);
  const toY = value => padY + (1 - ((value - min) / Math.max(0.0001, max - min))) * (height - 2 * padY);

  const points = rows.map((row, index) => ({ x: toX(index), y: toY(row.val) }));
  let path = `M ${round(points[0].x)} ${round(points[0].y)}`;
  for (let index = 1; index < points.length; index++) {
    path += ` L ${round(points[index].x)} ${round(points[index].y)}`;
  }
  const last = points[points.length - 1];

  return `<svg class="ph-weight-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="${path}" fill="none" stroke="#f4c95d" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="${round(last.x)}" cy="${round(last.y)}" r="1.4" fill="#f4c95d"></circle></svg>`;
}

function injectNetWeightSparkline(html, svg) {
  let value = String(html || '');
  if (!value || !svg || !value.includes('pH-Minus')) return value;

  if (!value.includes('data-ph-weight-history-style="1"')) {
    const css = `<style data-ph-weight-history-style="1">
.ph-weight-mini{min-height:78px;align-items:flex-start}
.ph-weight-mini .mini-content{width:100%;min-width:0}
.ph-weight-history{position:relative;height:24px;margin-top:3px;padding-right:29px;overflow:hidden}
.ph-weight-history .ph-weight-sparkline{display:block;width:100%;height:21px;overflow:visible}
.ph-weight-history-label{position:absolute;right:0;bottom:1px;font-size:8px;line-height:1;color:#91a3bb;font-weight:700;white-space:nowrap}
</style>`;
    value = value.includes('</head>') ? value.replace('</head>', `${css}</head>`) : css + value;
  }

  let markerIndex = value.indexOf('<div class="mini-label">pH-Minus</div>');
  if (markerIndex < 0) return value;

  const miniStart = value.lastIndexOf('<div class="mini ', markerIndex);
  if (miniStart >= 0) {
    const miniTagEnd = value.indexOf('>', miniStart);
    if (miniTagEnd > miniStart) {
      const openingTag = value.slice(miniStart, miniTagEnd);
      if (!openingTag.includes('ph-weight-mini')) {
        value = value.slice(0, miniTagEnd) + ' ph-weight-mini' + value.slice(miniTagEnd);
      }
    }
  }

  markerIndex = value.indexOf('<div class="mini-label">pH-Minus</div>');
  const valueMarker = '<div class="mini-value">';
  const valueStart = value.indexOf(valueMarker, markerIndex);
  if (valueStart < 0) return value;
  const valueEnd = value.indexOf('</div>', valueStart + valueMarker.length);
  if (valueEnd < 0) return value;

  const insertion = `<div class="ph-weight-history" title="Nettogewicht der letzten 7 Tage: Rohgewicht minus 0,500 kg">${svg}<span class="ph-weight-history-label">7 Tage</span></div>`;
  return value.slice(0, valueEnd + 6) + insertion + value.slice(valueEnd + 6);
}

function installNetWeightHistory(adapter) {
  if (!adapter || adapter.__phNetWeightHistoryInstalled) return adapter;
  adapter.__phNetWeightHistoryInstalled = true;
  adapter.__phNetWeightHistoryCache = { ts: 0, svg: '', values: [] };
  adapter.__phNetWeightHistoryPromise = null;

  async function refreshNetWeightHistory() {
    const now = Date.now();
    const stateId = String(adapter.config.phCanisterWeightStateId || PH_WEIGHT_STATE_ID).trim() || PH_WEIGHT_STATE_ID;
    let historyRows = [];

    try {
      if (typeof adapter.fetchHistoryValues === 'function') {
        historyRows = await adapter.fetchHistoryValues(stateId, now - HISTORY_WINDOW_MS, now, 'average', 336);
      }
    } catch (error) {
      if (adapter.config.debugMode) adapter.log.debug('[PH-GEWICHT] History-Abfrage fehlgeschlagen: ' + (error.message || error));
    }

    const netRows = (Array.isArray(historyRows) ? historyRows : [])
      .map(row => {
        const gross = numberValue(row && row.val !== undefined ? row.val : row);
        return {
          ts: Number(row && row.ts),
          val: gross === null ? null : Math.max(0, gross - PH_CANISTER_TARE_KG)
        };
      })
      .filter(row => Number.isFinite(row.ts) && Number.isFinite(row.val) && row.ts >= now - HISTORY_WINDOW_MS);

    // Den aktuellen Messwert ergänzen. Dadurch ist direkt nach Aktivierung der History
    // bereits eine saubere, zunächst flache Nettogewichtslinie sichtbar.
    try {
      const current = await adapter.getForeignStateAsync(stateId);
      const gross = numberValue(current && current.val);
      if (gross !== null) {
        const ts = Number((current && (current.ts || current.lc)) || now) || now;
        const net = Math.max(0, gross - PH_CANISTER_TARE_KG);
        const last = netRows[netRows.length - 1];
        if (!last || Math.abs(last.ts - ts) > 1000 || Math.abs(last.val - net) > 0.0005) {
          netRows.push({ ts, val: net });
        }
      }
    } catch {}

    netRows.sort((a, b) => a.ts - b.ts);
    const svg = buildNetWeightSparkline(netRows);
    adapter.__phNetWeightHistoryCache = { ts: now, svg, values: netRows };
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    try { adapter.queueRender(); } catch {}
    return svg;
  }

  function startHistoryRefresh(force = false) {
    const cache = adapter.__phNetWeightHistoryCache || { ts: 0 };
    if (!force && cache.ts && Date.now() - cache.ts < HISTORY_CACHE_MS) return;
    if (adapter.__phNetWeightHistoryPromise) return;

    adapter.__phNetWeightHistoryPromise = refreshNetWeightHistory()
      .catch(error => {
        adapter.log.warn('[PH-GEWICHT] 7-Tage-Kurve konnte nicht aktualisiert werden: ' + (error.message || error));
      })
      .finally(() => {
        adapter.__phNetWeightHistoryPromise = null;
      });
  }

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async function renderVisFullWithWeightHistory(force = false) {
    startHistoryRefresh(false);
    return baseRenderVisFull(force);
  };

  ['buildTabletHtml', 'buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget'].forEach(methodName => {
    if (typeof adapter[methodName] !== 'function') return;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function buildVisWithNetWeightHistory(data) {
      const cache = adapter.__phNetWeightHistoryCache || {};
      let html = original({ ...(data || {}), adapterVersion: ADAPTER_VERSION });
      html = String(html || '').replace(/v0\.4\.4/g, ADAPTER_VERSION);
      return injectNetWeightSparkline(html, cache.svg || '');
    };
  });

  adapter.on('ready', () => {
    startHistoryRefresh(true);
  });

  try {
    adapter.log.info('[PH-GEWICHT] v0.4.5: 7-Tage-Nettogewichtskurve aktiv, feste Tara 0,500 kg');
  } catch {}

  return adapter;
}

function createAdapter(options = {}) {
  return installNetWeightHistory(createFastAdapter(options));
}

if (require.main !== module) {
  module.exports = createAdapter;
} else {
  createAdapter();
}

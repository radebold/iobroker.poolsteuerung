'use strict';

const createReadableAdapter = require('./main-ipadmini-readable.js');

const ADAPTER_VERSION = 'v0.4.10';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';
const LOCAL_HISTORY_STATE = 'status.trend.ipadMiniLocal24hJson';
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_POINT_GAP_MS = 60 * 1000;
const MAX_POINTS_PER_SERIES = 288;

function numberValue(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatValue(value, digits) {
  const parsed = numberValue(value);
  return parsed === null ? '--' : parsed.toFixed(digits).replace('.', ',');
}

function normalizeRows(values, startTs, endTs) {
  return (Array.isArray(values) ? values : [])
    .map(row => ({ ts: Number(row && row.ts), val: numberValue(row && row.val) }))
    .filter(row => Number.isFinite(row.ts) && Number.isFinite(row.val) && row.ts >= startTs && row.ts <= endTs)
    .sort((a, b) => a.ts - b.ts);
}

function appendPoint(rows, value, now) {
  const parsed = numberValue(value);
  const start = now - HISTORY_WINDOW_MS;
  const result = normalizeRows(rows, start, now);
  if (parsed === null) return result;

  const last = result[result.length - 1];
  if (!last || now - last.ts >= MIN_POINT_GAP_MS || Math.abs(last.val - parsed) > 0.0001) {
    result.push({ ts: now, val: parsed });
  } else {
    last.val = parsed;
    last.ts = now;
  }

  if (result.length > MAX_POINTS_PER_SERIES) {
    return result.slice(result.length - MAX_POINTS_PER_SERIES);
  }
  return result;
}

function buildSparkline(rows, currentValue, color, digits, minRange) {
  const now = Date.now();
  let values = normalizeRows(rows, now - HISTORY_WINDOW_MS, now);
  const current = numberValue(currentValue);

  if (!values.length && current !== null) {
    values = [
      { ts: now - 60 * 60 * 1000, val: current },
      { ts: now, val: current }
    ];
  } else if (values.length === 1) {
    values = [
      { ts: Math.max(now - HISTORY_WINDOW_MS, values[0].ts - 60 * 60 * 1000), val: values[0].val },
      values[0]
    ];
  }

  if (values.length < 2) return null;

  const nums = values.map(row => row.val);
  const actualMin = Math.min(...nums);
  const actualMax = Math.max(...nums);
  const visibleRange = Math.max(actualMax - actualMin, minRange);
  const center = (actualMin + actualMax) / 2;
  let min = center - visibleRange / 2;
  let max = center + visibleRange / 2;
  const margin = (max - min) * 0.12;
  min -= margin;
  max += margin;

  const width = 460;
  const height = 105;
  const pad = { l: 3, r: 3, t: 8, b: 10 };
  const firstTs = values[0].ts;
  const lastTs = values[values.length - 1].ts;
  const timeRange = Math.max(1, lastTs - firstTs);
  const valRange = Math.max(0.0001, max - min);
  const round = value => Math.round(value * 10) / 10;
  const x = ts => pad.l + ((ts - firstTs) / timeRange) * (width - pad.l - pad.r);
  const y = val => pad.t + (1 - ((val - min) / valRange)) * (height - pad.t - pad.b);

  let path = '';
  values.forEach((row, index) => {
    path += `${index ? ' L' : 'M'} ${round(x(row.ts))} ${round(y(row.val))}`;
  });

  const last = values[values.length - 1];
  const svg = `<svg class="history-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="27" x2="${width}" y2="27" class="grid-line"></line>
    <line x1="0" y1="53" x2="${width}" y2="53" class="grid-line"></line>
    <line x1="0" y1="79" x2="${width}" y2="79" class="grid-line"></line>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="${round(x(last.ts))}" cy="${round(y(last.val))}" r="3" fill="${color}"></circle>
  </svg>`;

  return {
    svg,
    minText: formatValue(actualMin, digits),
    maxText: formatValue(actualMax, digits)
  };
}

function patchCard(html, label, chart, unit) {
  if (!chart) return html;
  const labelMarker = `<span class="metric-label">${label}</span>`;
  const labelIndex = html.indexOf(labelMarker);
  if (labelIndex < 0) return html;

  const cardStart = html.lastIndexOf('<section class="metric-card"', labelIndex);
  const cardEnd = html.indexOf('</section>', labelIndex);
  if (cardStart < 0 || cardEnd < 0) return html;

  let card = html.slice(cardStart, cardEnd + 10);
  if (!card.includes('History sammelt noch Daten')) return html;

  card = card.replace('<div class="history-empty">History sammelt noch Daten</div>', chart.svg);
  const unitText = unit ? ` ${unit}` : '';
  card = card.replace(
    /<div class="history-meta">[\s\S]*?<\/div>/,
    `<div class="history-meta"><span>Min ${chart.minText}${unitText}</span><span>Max ${chart.maxText}${unitText}</span></div>`
  );

  return html.slice(0, cardStart) + card + html.slice(cardEnd + 10);
}

function installHistoryFallback(adapter) {
  if (!adapter || adapter.__ipadMiniHistoryFallbackInstalled) return adapter;
  adapter.__ipadMiniHistoryFallbackInstalled = true;
  adapter.__ipadMiniHistoryFallbackData = null;
  adapter.__ipadMiniLocalHistory = { outside: [], water: [], ph: [], orp: [] };
  adapter.__ipadMiniLocalHistoryLoaded = false;

  async function ensureLocalHistoryLoaded() {
    if (adapter.__ipadMiniLocalHistoryLoaded) return;
    adapter.__ipadMiniLocalHistoryLoaded = true;
    try {
      await adapter.ensureState(LOCAL_HISTORY_STATE, 'string', 'json', '{}', false);
      const raw = await adapter.getText(adapter.namespace + '.' + LOCAL_HISTORY_STATE, '{}');
      const parsed = JSON.parse(raw || '{}');
      const now = Date.now();
      const start = now - HISTORY_WINDOW_MS;
      adapter.__ipadMiniLocalHistory = {
        outside: normalizeRows(parsed.outside, start, now),
        water: normalizeRows(parsed.water, start, now),
        ph: normalizeRows(parsed.ph, start, now),
        orp: normalizeRows(parsed.orp, start, now)
      };
    } catch {
      adapter.__ipadMiniLocalHistory = { outside: [], water: [], ph: [], orp: [] };
    }
  }

  async function recordCurrentValues() {
    await ensureLocalHistoryLoaded();
    const data = adapter.__ipadMiniHistoryFallbackData;
    if (!data) return;
    const now = Date.now();
    const history = adapter.__ipadMiniLocalHistory;
    history.outside = appendPoint(history.outside, data.outsideTemp, now);
    history.water = appendPoint(history.water, data.poolTemp, now);
    history.ph = appendPoint(history.ph, data.ph, now);
    history.orp = appendPoint(history.orp, data.orp, now);
    try {
      await adapter.setStateIfChanged(LOCAL_HISTORY_STATE, JSON.stringify(history), true);
    } catch {}
  }

  async function patchRenderedHtml() {
    const data = adapter.__ipadMiniHistoryFallbackData;
    if (!data) return;
    const state = await adapter.getStateAsync(IPAD_MINI_STATE);
    if (!state || typeof state.val !== 'string' || !state.val.includes('History sammelt noch Daten')) return;

    let html = String(state.val).replace(/v0\.4\.[5-9]/g, ADAPTER_VERSION);
    const history = adapter.__ipadMiniLocalHistory;
    html = patchCard(html, 'Außentemperatur', buildSparkline(history.outside, data.outsideTemp, '#58baff', 1, 1.0), '°C');
    html = patchCard(html, 'Wassertemperatur', buildSparkline(history.water, data.poolTemp, '#57dfdc', 1, 1.0), '°C');
    html = patchCard(html, 'pH-Wert', buildSparkline(history.ph, data.ph, data.phInRange ? '#67df7e' : '#ffbd59', 2, 0.10), '');
    html = patchCard(html, 'ORP-Wert', buildSparkline(history.orp, data.orp, data.orpInRange ? '#67df7e' : '#ff9f59', 0, 30), 'mV');
    await adapter.setStateIfChanged(IPAD_MINI_STATE, html, true);
  }

  const originalTabletBuilder = adapter.buildTabletHtml.bind(adapter);
  adapter.buildTabletHtml = function captureHistoryFallbackData(data) {
    adapter.__ipadMiniHistoryFallbackData = { ...(data || {}) };
    return String(originalTabletBuilder({ ...(data || {}), adapterVersion: ADAPTER_VERSION }))
      .replace(/v0\.4\.[5-9]/g, ADAPTER_VERSION);
  };

  for (const methodName of ['buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchVersion(data) {
      return String(original({ ...(data || {}), adapterVersion: ADAPTER_VERSION }))
        .replace(/v0\.4\.[5-9]/g, ADAPTER_VERSION);
    };
  }

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async function renderWithHistoryFallback(force = false) {
    const result = await baseRenderVisFull(force);
    await recordCurrentValues();
    await patchRenderedHtml();
    return result;
  };

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await ensureLocalHistoryLoaded();
        await adapter.forceImmediateRender();
      } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] lokaler History-Fallback fehlgeschlagen: ' + (error.message || error));
      }
    }, 4500));
  });

  try {
    adapter.log.info('[IPAD-MINI] v0.4.10: lokaler 24h-Puffer und sofort sichtbare Fallback-Linien aktiv');
  } catch {}

  return adapter;
}

function createAdapter(options = {}) {
  return installHistoryFallback(createReadableAdapter(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

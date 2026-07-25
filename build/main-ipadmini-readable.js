'use strict';

const createDashboardAdapter = require('./main-ipadmini.js');

const ADAPTER_VERSION = 'v0.4.9';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_CACHE_MS = 5 * 60 * 1000;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function numberValue(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatValue(value, digits) {
  const parsed = numberValue(value);
  if (parsed === null) return '--';
  return parsed.toFixed(digits).replace('.', ',');
}

function normalizeRows(values, startTs, endTs) {
  return (Array.isArray(values) ? values : [])
    .map(row => ({
      ts: Number(row && row.ts),
      val: numberValue(row && row.val !== undefined ? row.val : row)
    }))
    .filter(row => Number.isFinite(row.ts) && Number.isFinite(row.val) && row.ts >= startTs && row.ts <= endTs)
    .sort((a, b) => a.ts - b.ts);
}

function compactRows(values, maxPoints = 120) {
  const rows = Array.isArray(values) ? values : [];
  if (rows.length <= maxPoints) return rows;
  const result = [];
  for (let index = 0; index < maxPoints; index++) {
    result.push(rows[Math.round(index * (rows.length - 1) / (maxPoints - 1))]);
  }
  return result;
}

function addCurrentPoint(rows, value, now) {
  const result = Array.isArray(rows) ? rows.map(row => ({ ...row })) : [];
  const parsed = numberValue(value);
  if (parsed === null) return result;
  const last = result[result.length - 1];
  if (!last || now - last.ts > 15000 || Math.abs(last.val - parsed) > 0.0001) {
    result.push({ ts: now, val: parsed });
  }
  return result;
}

function buildSparkline(rows, color, digits, minRange) {
  const values = compactRows(rows, 120);
  if (values.length < 2) {
    return {
      svg: '<div class="history-empty">History sammelt noch Daten</div>',
      minText: '--',
      maxText: '--'
    };
  }

  const nums = values.map(row => row.val);
  const actualMin = Math.min(...nums);
  const actualMax = Math.max(...nums);
  let min = actualMin;
  let max = actualMax;
  const visibleRange = Math.max(max - min, minRange);
  const center = (min + max) / 2;
  min = center - visibleRange / 2;
  max = center + visibleRange / 2;
  const margin = (max - min) * 0.12;
  min -= margin;
  max += margin;

  const width = 460;
  const height = 105;
  const pad = { l: 3, r: 3, t: 8, b: 10 };
  const startTs = values[0].ts;
  const endTs = values[values.length - 1].ts;
  const timeRange = Math.max(1, endTs - startTs);
  const valRange = Math.max(0.0001, max - min);
  const round = value => Math.round(value * 10) / 10;
  const x = ts => pad.l + ((ts - startTs) / timeRange) * (width - pad.l - pad.r);
  const y = val => pad.t + (1 - ((val - min) / valRange)) * (height - pad.t - pad.b);

  let path = '';
  values.forEach((row, index) => {
    path += `${index ? ' L' : 'M'} ${round(x(row.ts))} ${round(y(row.val))}`;
  });
  const last = values[values.length - 1];
  const lastX = round(x(last.ts));
  const lastY = round(y(last.val));

  const svg = `<svg class="history-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="27" x2="${width}" y2="27" class="grid-line"></line>
    <line x1="0" y1="53" x2="${width}" y2="53" class="grid-line"></line>
    <line x1="0" y1="79" x2="${width}" y2="79" class="grid-line"></line>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="${lastX}" cy="${lastY}" r="3" fill="${color}"></circle>
  </svg>`;

  return {
    svg,
    minText: formatValue(actualMin, digits),
    maxText: formatValue(actualMax, digits)
  };
}

function iconSvg(type) {
  const icons = {
    outside: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    water: '<svg viewBox="0 0 24 24"><path d="M12 2C8.3 7 5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-3.3-8-7-13Z"/><path d="M8.5 16.5c1.2 1.4 2.5 2 4 2"/></svg>',
    ph: '<svg viewBox="0 0 24 24"><path d="M9 2h6M10 2v6l-5 9a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-9V2"/><path d="M8 15h8"/></svg>',
    orp: '<svg viewBox="0 0 24 24"><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z"/></svg>'
  };
  return icons[type] || icons.water;
}

function trendClass(trend) {
  if (trend === '↑') return 'up';
  if (trend === '↓') return 'down';
  return 'flat';
}

function scheduleHtml(text) {
  const rows = String(text || '--')
    .split(/\n+/)
    .map(row => row.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!rows.length || rows[0] === '--') return '<span class="schedule-empty">Keine kommenden Schaltungen</span>';
  return rows.map(row => `<span class="schedule-chip">${esc(row)}</span>`).join('');
}

function buildReadableHtml(data, history) {
  const cards = [
    { key: 'outside', label: 'Außentemperatur', value: data.outsideTemp, digits: 1, unit: '°C', color: '#58baff', icon: 'outside', trend: data.outsideTempTrend, minRange: 1.0 },
    { key: 'water', label: 'Wassertemperatur', value: data.poolTemp, digits: 1, unit: '°C', color: '#57dfdc', icon: 'water', trend: data.poolTempTrend, minRange: 1.0 },
    { key: 'ph', label: 'pH-Wert', value: data.ph, digits: 2, unit: '', color: data.phInRange ? '#67df7e' : '#ffbd59', icon: 'ph', trend: data.phTrend, minRange: 0.10 },
    { key: 'orp', label: 'ORP-Wert', value: data.orp, digits: 0, unit: 'mV', color: data.orpInRange ? '#67df7e' : '#ff9f59', icon: 'orp', trend: data.orpTrend, minRange: 30 }
  ];

  const cardHtml = cards.map(card => {
    const chart = buildSparkline(history[card.key] || [], card.color, card.digits, card.minRange);
    return `<section class="metric-card" style="--accent:${card.color}">
      <div class="metric-head">
        <span class="metric-icon">${iconSvg(card.icon)}</span>
        <span class="metric-label">${esc(card.label)}</span>
        <span class="metric-period">24 Stunden</span>
      </div>
      <div class="metric-reading">
        <span class="metric-value">${esc(formatValue(card.value, card.digits))}</span>
        ${card.unit ? `<span class="metric-unit">${esc(card.unit)}</span>` : ''}
        <span class="metric-trend ${trendClass(card.trend)}">${esc(card.trend || '→')}</span>
      </div>
      <div class="history-wrap">${chart.svg}</div>
      <div class="history-meta"><span>Min ${esc(chart.minText)}${card.unit ? ` ${esc(card.unit)}` : ''}</span><span>Max ${esc(chart.maxText)}${card.unit ? ` ${esc(card.unit)}` : ''}</span></div>
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Pool iPad Mini</title>
<style>
:root{--bg:#06111e;--panel:#0d2035;--line:rgba(255,255,255,.10);--text:#f6fbff;--muted:#9bb0c8;--green:#67df7e;--orange:#ffbd59}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--text)}
.screen{width:100vw;height:100vh;padding:10px 12px;display:grid;grid-template-rows:40px minmax(0,1fr) 42px;gap:8px;background:radial-gradient(circle at 10% -10%,rgba(53,145,230,.20),transparent 35%),linear-gradient(145deg,#06101c,#0a1a2c 58%,#07131f)}
.header{display:flex;align-items:center;justify-content:space-between;padding:0 4px}
.brand{display:flex;align-items:center;gap:9px}.brand-icon{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(145deg,#228bd8,#28c8c0)}.brand-icon svg{width:19px;height:19px;fill:none;stroke:#fff;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.brand-title{font-size:21px;font-weight:900;letter-spacing:.08em}.brand-sub{font-size:9px;color:var(--muted);font-weight:700;letter-spacing:.11em;text-transform:uppercase}.header-meta{text-align:right;font-size:9px;color:var(--muted);line-height:1.3}
.cards{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:8px;min-height:0}
.metric-card{position:relative;min-width:0;min-height:0;overflow:hidden;border:1px solid var(--line);border-radius:17px;padding:13px 15px 10px;background:linear-gradient(150deg,rgba(17,40,65,.98),rgba(8,24,41,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 9px 22px rgba(0,0,0,.18)}
.metric-card:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--accent)}
.metric-head{height:30px;display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:8px}.metric-icon{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.08)}.metric-icon svg{width:17px;height:17px;fill:none;stroke:var(--accent);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.metric-label{font-size:17px;font-weight:850;color:#e7f1fb}.metric-period{font-size:9px;color:var(--muted);font-weight:750;text-transform:uppercase;letter-spacing:.06em}
.metric-reading{height:92px;display:flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap}.metric-value{font-size:82px;font-weight:900;line-height:.88;letter-spacing:-.055em;color:var(--accent);font-variant-numeric:tabular-nums}.metric-unit{font-size:27px;font-weight:850;color:rgba(247,251,255,.80)}.metric-trend{font-size:31px;font-weight:900}.metric-trend.up{color:var(--green)}.metric-trend.down{color:var(--orange)}.metric-trend.flat{color:#afbed0}
.history-wrap{height:105px;border-radius:10px;overflow:hidden;background:rgba(3,14,25,.30)}.history-svg{display:block;width:100%;height:100%}.grid-line{stroke:rgba(255,255,255,.07);stroke-width:1}.history-empty{height:100%;display:grid;place-items:center;color:var(--muted);font-size:12px;font-weight:700}.history-meta{height:20px;display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:10px;font-weight:750;padding-top:4px}
.schedule{border:1px solid var(--line);border-radius:13px;background:rgba(10,28,47,.96);display:grid;grid-template-columns:auto 1fr;align-items:center;gap:10px;padding:6px 10px;overflow:hidden}.schedule-label{font-size:10px;color:var(--muted);font-weight:900;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}.schedule-list{display:flex;justify-content:flex-end;gap:6px;overflow:hidden}.schedule-chip{max-width:27%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(84,200,255,.17);background:rgba(84,200,255,.09);border-radius:999px;padding:5px 8px;font-size:9px;color:#deedff;font-weight:750}.schedule-empty{font-size:10px;color:var(--muted)}
@media(max-width:900px){.metric-value{font-size:70px}.metric-label{font-size:15px}.history-wrap{height:92px}}
</style>
</head>
<body>
<main class="screen">
<header class="header"><div class="brand"><span class="brand-icon">${iconSvg('water')}</span><div><div class="brand-title">POOL</div><div class="brand-sub">24h Live-Verlauf</div></div></div><div class="header-meta"><div>${esc(data.updated || '--')}</div><div>${ADAPTER_VERSION} · iPad Mini · 1024 × 768</div></div></header>
<section class="cards">${cardHtml}</section>
<footer class="schedule"><div class="schedule-label">Nächste Schaltungen</div><div class="schedule-list">${scheduleHtml(data.nextActionsText)}</div></footer>
</main>
</body>
</html>`;
}

function installReadableIpadMini(adapter) {
  if (!adapter || adapter.__readableIpadMiniInstalled) return adapter;
  adapter.__readableIpadMiniInstalled = true;
  adapter.__readableIpadMiniData = null;
  adapter.__readableIpadMiniHistory = { ts: 0, outside: [], water: [], ph: [], orp: [] };
  adapter.__readableIpadMiniHistoryPromise = null;

  async function readLocalRows(stateId, startTs, endTs) {
    try {
      const raw = await adapter.getText(stateId, '[]');
      return normalizeRows(JSON.parse(raw || '[]'), startTs, endTs);
    } catch {
      return [];
    }
  }

  async function fetchRows(stateId, startTs, endTs) {
    if (!stateId || typeof adapter.fetchHistoryValues !== 'function') return [];
    try {
      return normalizeRows(await adapter.fetchHistoryValues(stateId, startTs, endTs, 'average', 144), startTs, endTs);
    } catch (error) {
      if (adapter.config.debugMode) adapter.log.debug('[IPAD-MINI] History nicht lesbar: ' + stateId + ' | ' + (error.message || error));
      return [];
    }
  }

  async function refreshHistory(force = false) {
    const cache = adapter.__readableIpadMiniHistory;
    if (!force && cache.ts && Date.now() - cache.ts < HISTORY_CACHE_MS) return cache;
    const now = Date.now();
    const start = now - HISTORY_WINDOW_MS;
    const ids = {
      outside: String(adapter.config.outsideTempStateId || '').trim(),
      water: String(adapter.config.waterTempStateId || '').trim(),
      ph: String(adapter.config.phStateId || '').trim(),
      orp: String(adapter.config.orpStateId || '').trim()
    };

    const [outside, water, ph, orp] = await Promise.all([
      fetchRows(ids.outside, start, now),
      fetchRows(ids.water, start, now),
      fetchRows(ids.ph, start, now),
      fetchRows(ids.orp, start, now)
    ]);

    const data = adapter.__readableIpadMiniData || {};
    const result = {
      ts: now,
      outside: addCurrentPoint(outside, data.outsideTemp, now),
      water: addCurrentPoint(water.length ? water : await readLocalRows(adapter.namespace + '.status.trend.poolTemp24hJson', start, now), data.poolTemp, now),
      ph: addCurrentPoint(ph.length ? ph : await readLocalRows(adapter.namespace + '.status.trend.phTodayJson', start, now), data.ph, now),
      orp: addCurrentPoint(orp.length ? orp : await readLocalRows(adapter.namespace + '.status.trend.orpTodayJson', start, now), data.orp, now)
    };
    adapter.__readableIpadMiniHistory = result;
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    try { adapter.queueRender(); } catch {}
    return result;
  }

  function startHistoryRefresh(force = false) {
    const cache = adapter.__readableIpadMiniHistory;
    if (!force && cache.ts && Date.now() - cache.ts < HISTORY_CACHE_MS) return Promise.resolve(cache);
    if (adapter.__readableIpadMiniHistoryPromise) return adapter.__readableIpadMiniHistoryPromise;
    adapter.__readableIpadMiniHistoryPromise = refreshHistory(force)
      .catch(error => {
        adapter.log.warn('[IPAD-MINI] Lesbare Verlaufskarten konnten nicht aktualisiert werden: ' + (error.message || error));
        return adapter.__readableIpadMiniHistory;
      })
      .finally(() => { adapter.__readableIpadMiniHistoryPromise = null; });
    return adapter.__readableIpadMiniHistoryPromise;
  }

  const originalTabletBuilder = adapter.buildTabletHtml.bind(adapter);
  adapter.buildTabletHtml = function captureReadableData(data) {
    adapter.__readableIpadMiniData = { ...(data || {}) };
    return String(originalTabletBuilder({ ...(data || {}), adapterVersion: ADAPTER_VERSION })).replace(/v0\.4\.[5-8]/g, ADAPTER_VERSION);
  };

  for (const methodName of ['buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchVersion(data) {
      return String(original({ ...(data || {}), adapterVersion: ADAPTER_VERSION })).replace(/v0\.4\.[5-8]/g, ADAPTER_VERSION);
    };
  }

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async function renderReadableIpadMini(force = false) {
    await this.ensureState(IPAD_MINI_STATE, 'string', 'html', '', false);
    const result = await baseRenderVisFull(force);
    startHistoryRefresh(false);
    const data = this.__readableIpadMiniData;
    if (data) {
      const html = buildReadableHtml(data, this.__readableIpadMiniHistory || {});
      await this.setStateIfChanged(IPAD_MINI_STATE, html, true);
    }
    return result;
  };

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState(IPAD_MINI_STATE, 'string', 'html', '', false);
        await startHistoryRefresh(true);
        await adapter.forceImmediateRender();
      } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Start der lesbaren Ansicht fehlgeschlagen: ' + (error.message || error));
      }
    }, 3200));
  });

  try {
    adapter.log.info('[IPAD-MINI] v0.4.9: gut lesbare 2x2-Ansicht mit vier statischen 24h-Verläufen aktiv');
  } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return installReadableIpadMini(createDashboardAdapter(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

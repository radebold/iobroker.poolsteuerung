'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.44';
const STATE_ID = 'vis.htmlIpadMini';
const MAX_HTML_BYTES = 28000;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function numberValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'ja', 'yes', 'active', 'aktiv'].includes(String(value ?? '').trim().toLowerCase());
}

function formatValue(value, digits) {
  const parsed = numberValue(value);
  return parsed === null ? '--' : parsed.toFixed(digits).replace('.', ',');
}

function normalizeRows(values) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  return (Array.isArray(values) ? values : [])
    .map(row => ({ ts: Number(row && row.ts), val: numberValue(row && (row.val !== undefined ? row.val : row)) }))
    .filter(row => Number.isFinite(row.ts) && row.val !== null && row.ts >= start && row.ts <= now)
    .sort((a, b) => a.ts - b.ts);
}

function addCurrent(rows, value) {
  const result = normalizeRows(rows);
  const current = numberValue(value);
  if (current === null) return result;
  const now = Date.now();
  const last = result[result.length - 1];
  if (!last || now - last.ts > 15000 || Math.abs(last.val - current) > 0.0001) result.push({ ts: now, val: current });
  if (result.length === 1) result.unshift({ ts: now - 60 * 60 * 1000, val: current });
  if (!result.length) result.push({ ts: now - 60 * 60 * 1000, val: current }, { ts: now, val: current });
  return result;
}

function compactRows(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const result = [];
  for (let index = 0; index < maxPoints; index++) {
    result.push(rows[Math.round(index * (rows.length - 1) / (maxPoints - 1))]);
  }
  return result;
}

function chart(rows, current, color, digits, minRange, maxPoints) {
  const values = compactRows(addCurrent(rows, current), maxPoints);
  if (values.length < 2) return { svg: '<div class="history-empty">History sammelt noch Daten</div>', min: '--', max: '--' };

  const nums = values.map(row => row.val);
  const actualMin = Math.min(...nums);
  const actualMax = Math.max(...nums);
  const visibleRange = Math.max(actualMax - actualMin, minRange);
  const center = (actualMin + actualMax) / 2;
  const min = center - visibleRange * 0.62;
  const max = center + visibleRange * 0.62;
  const firstTs = values[0].ts;
  const lastTs = values[values.length - 1].ts;
  const timeRange = Math.max(1, lastTs - firstTs);
  const valueRange = Math.max(0.0001, max - min);
  const round = value => Math.round(value * 10) / 10;
  const x = ts => 3 + ((ts - firstTs) / timeRange) * 454;
  const y = val => 8 + (1 - ((val - min) / valueRange)) * 87;
  const path = values.map((row, index) => `${index ? 'L' : 'M'}${round(x(row.ts))} ${round(y(row.val))}`).join(' ');
  const last = values[values.length - 1];
  return {
    svg: `<svg class="history-svg" viewBox="0 0 460 105" preserveAspectRatio="none"><path class="grid" d="M0 27H460M0 53H460M0 79H460"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${round(x(last.ts))}" cy="${round(y(last.val))}" r="3" fill="${color}"/></svg>`,
    min: formatValue(actualMin, digits),
    max: formatValue(actualMax, digits)
  };
}

function scheduleHtml(text) {
  const rows = String(text || '--').split(/\n+/).map(row => row.trim()).filter(Boolean).slice(0, 3);
  if (!rows.length || rows[0] === '--') return '<span class="schedule-empty">Keine kommenden Schaltungen</span>';
  return rows.map(row => `<span class="schedule-chip">${esc(row)}</span>`).join('');
}

function canisterHtml(data) {
  const canister = data.phCanister || {};
  const level = numberValue(canister.levelL);
  const percent = numberValue(canister.percent);
  const netKg = numberValue(canister.netKg ?? canister.weightKg ?? canister.currentWeightKg);
  const stateClass = canister.critical ? 'critical' : canister.warn ? 'warn' : 'ok';
  if (level === null) return '<span class="canister critical"><b>pH-Minus --</b><small>nicht verfügbar</small></span>';
  const secondary = [netKg === null ? '' : `${formatValue(netKg, 3)} kg`, percent === null ? '' : `${formatValue(percent, 0)} %`].filter(Boolean).join(' · ');
  return `<span class="canister ${stateClass}"><b>pH-Minus ${canister.scaleEnabled === true ? '≈ ' : ''}${formatValue(level, 2)} l</b><small>${esc(secondary)}</small></span>`;
}

function heatingValue(data) {
  if (!boolValue(data.heatpumpOn)) return false;
  return /(heiz|heat|warm)/i.test(String(data.heatpumpMode ?? ''));
}

function buildHtml(data, history, maxPoints) {
  const pumpOn = boolValue(data.pumpOn);
  const phPumpOn = boolValue(data.phPumpOn);
  const chlorOn = boolValue(data.chlorOn);
  const heatpumpOn = boolValue(data.heatpumpOn);
  const heating = heatingValue(data);
  const fan = numberValue(data.heatpumpFanPercent);

  const cards = [
    { key: 'outside', label: 'Außentemperatur', value: data.outsideTemp, digits: 1, unit: '°C', color: '#58baff', trend: data.outsideTempTrend, range: 1 },
    { key: 'water', label: 'Wassertemperatur', value: data.poolTemp, digits: 1, unit: '°C', color: '#60ddd9', trend: data.poolTempTrend, range: 1 },
    { key: 'ph', label: 'pH-Wert', value: data.ph, digits: 2, unit: '', color: data.phInRange ? '#67df7e' : '#ffbd59', trend: data.phTrend, range: 0.1 },
    { key: 'orp', label: 'ORP-Wert', value: data.orp, digits: 0, unit: 'mV', color: data.orpInRange ? '#67df7e' : '#ff9f59', trend: data.orpTrend, range: 30 }
  ];

  const cardHtml = cards.map(card => {
    const graph = chart(history[card.key] || [], card.value, card.color, card.digits, card.range, maxPoints);
    const controls = card.key === 'ph'
      ? `<div class="card-controls"><div class="dose-buttons"><button data-dose="60"><b>60 Sek.</b><small>Start Dosierung</small></button><button data-dose="120"><b>120 Sek.</b><small>Start Dosierung</small></button><button data-dose="180"><b>180 Sek.</b><small>Start Dosierung</small></button></div><span class="device ${phPumpOn ? 'on' : ''}"><i></i>Dosierpumpe ${phPumpOn ? 'EIN' : 'AUS'}</span></div>`
      : card.key === 'orp'
        ? `<div class="card-controls"><span></span><span class="device ${chlorOn ? 'on' : ''}"><i></i>Chlorinator ${chlorOn ? 'EIN' : 'AUS'}</span></div>`
        : '<div class="card-controls"></div>';

    return `<section class="metric-card" style="--accent:${card.color}"><div class="metric-head"><span class="metric-icon">${card.key === 'outside' ? '☀' : card.key === 'water' ? '◉' : card.key === 'ph' ? '⚗' : 'ϟ'}</span><span class="metric-label">${esc(card.label)}</span>${card.key === 'ph' ? canisterHtml(data) : '<span class="metric-period">24 Stunden</span>'}</div><div class="metric-reading"><span class="metric-value">${esc(formatValue(card.value, card.digits))}</span>${card.unit ? `<span class="metric-unit">${esc(card.unit)}</span>` : ''}<span class="metric-trend">${esc(card.trend || '→')}</span></div>${controls}<div class="history-wrap">${graph.svg}</div><div class="history-meta"><span>Min ${esc(graph.min)}${card.unit ? ` ${esc(card.unit)}` : ''}</span><span>Max ${esc(graph.max)}${card.unit ? ` ${esc(card.unit)}` : ''}</span></div></section>`;
  }).join('');

  const namespace = JSON.stringify(String(data.namespace || 'poolsteuerung.0'));
  return `<style data-ipad-final="1">*{box-sizing:border-box}.ipad-final{position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;padding:8px 10px;display:grid;grid-template-rows:38px minmax(0,1fr) 38px 38px;gap:7px;overflow:hidden;background:radial-gradient(circle at 10% -10%,rgba(53,145,230,.20),transparent 35%),linear-gradient(145deg,#06101c,#0a1a2c 58%,#07131f);color:#f6fbff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.ipad-final header{display:flex;align-items:center;justify-content:space-between;padding:0 4px}.brand{display:flex;align-items:center;gap:9px}.brand-mark{width:29px;height:29px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(145deg,#228bd8,#28c8c0);font-size:16px}.brand-title{display:flex;align-items:center;gap:10px;font-size:21px;font-weight:900;letter-spacing:.08em}.brand-sub,.meta{font-size:9px;color:#9bb0c8;font-weight:700}.meta{text-align:right;line-height:1.3}.pump{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.055);font-size:8px;letter-spacing:0}.pump i,.device i{width:10px;height:10px;border-radius:50%;background:#77899c}.pump.on i,.device.on i{background:#62e27c;box-shadow:0 0 10px rgba(98,226,124,.65)}.pump:not(.on) i{background:#ff655c;box-shadow:0 0 9px rgba(255,101,92,.45)}.cards{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:7px;min-height:0}.metric-card{position:relative;min-width:0;min-height:0;overflow:hidden;border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:10px 14px 8px;background:linear-gradient(150deg,rgba(17,40,65,.98),rgba(8,24,41,.98));display:grid;grid-template-rows:30px 78px 30px minmax(70px,1fr) 18px}.metric-card:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--accent)}.metric-head{display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:8px}.metric-icon{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.08);color:var(--accent)}.metric-label{font-size:17px;font-weight:850}.metric-period{font-size:8px;color:#9bb0c8;font-weight:800;text-transform:uppercase}.metric-reading{display:flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap}.metric-value{font-size:73px;font-weight:900;line-height:.88;letter-spacing:-.055em;color:var(--accent)}.metric-unit{font-size:25px;font-weight:850;color:rgba(247,251,255,.8)}.metric-trend{font-size:29px;font-weight:900;color:#afbed0}.card-controls{display:flex;align-items:center;justify-content:space-between;gap:7px;min-width:0}.dose-buttons{display:flex;gap:5px}.dose-buttons button{width:62px;height:28px;padding:2px 4px;border:1px solid rgba(255,255,255,.12);border-radius:9px;background:linear-gradient(180deg,#2d4f86,#162d52);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer}.dose-buttons b{font-size:9px;line-height:10px}.dose-buttons small{font-size:6px;line-height:7px;color:#dbeafe}.dose-buttons button:disabled{opacity:.6}.device{display:inline-flex;align-items:center;gap:6px;height:21px;padding:3px 7px;border:1px solid rgba(255,255,255,.11);border-radius:999px;background:rgba(4,17,30,.82);font-size:8px;font-weight:900;color:#aab9c8;white-space:nowrap}.device.on{color:#a8f4b7;border-color:rgba(98,226,124,.25);background:rgba(37,110,55,.26)}.history-wrap{min-height:0;border-radius:9px;overflow:hidden;background:rgba(3,14,25,.3)}.history-svg{width:100%;height:100%;display:block}.grid{fill:none;stroke:rgba(255,255,255,.07);stroke-width:1}.history-empty{height:100%;display:grid;place-items:center;color:#9bb0c8;font-size:11px}.history-meta{display:flex;align-items:center;justify-content:space-between;color:#9bb0c8;font-size:9px;font-weight:750}.canister{min-width:135px;padding:3px 7px;border:1px solid rgba(164,124,255,.22);border-radius:8px;background:rgba(4,17,30,.84);text-align:right}.canister b,.canister small{display:block}.canister b{font-size:8px}.canister small{font-size:7px;color:#9bb0c8}.canister.ok b{color:#7cea91}.canister.warn b{color:#ffd06e}.canister.critical b{color:#ff756d}.heat,.schedule{border:1px solid rgba(255,255,255,.10);border-radius:12px;background:rgba(10,28,47,.96);align-items:center;padding:5px 9px}.heat{display:grid;grid-template-columns:1.3fr repeat(3,1fr);gap:5px}.heat>div{display:flex;justify-content:space-between;gap:6px;padding:0 8px;border-left:1px solid rgba(255,255,255,.07);font-size:9px;color:#9bb0c8}.heat>div:first-child{border-left:0;color:#eaf4ff;font-size:11px;font-weight:900}.heat b{font-size:11px;color:#dbe9f6}.heat b.on{color:#67df7e}.schedule{display:grid;grid-template-columns:auto 1fr;gap:9px;overflow:hidden}.schedule-label{font-size:9px;color:#9bb0c8;font-weight:900;text-transform:uppercase}.schedule-list{display:flex;justify-content:flex-end;gap:5px;overflow:hidden}.schedule-chip{max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(84,200,255,.17);background:rgba(84,200,255,.09);border-radius:999px;padding:4px 7px;font-size:8px;color:#deedff;font-weight:750}.schedule-empty{font-size:9px;color:#9bb0c8}@media(max-width:900px){.metric-value{font-size:64px}.metric-label{font-size:15px}.dose-buttons button{width:55px;height:25px}.dose-buttons b{font-size:8px}.dose-buttons small{font-size:5px}.device{font-size:7px}.canister{min-width:120px}.heat>div{font-size:8px;padding:0 5px}.heat b{font-size:10px}}</style><main class="ipad-final"><header><div class="brand"><span class="brand-mark">◉</span><div><div class="brand-title">POOL<span class="pump ${pumpOn ? 'on' : ''}"><i></i>Umwälzpumpe ${pumpOn ? 'EIN' : 'AUS'}</span></div><div class="brand-sub">24H LIVE-VERLAUF</div></div></div><div class="meta"><div>${esc(data.updated || '--')}</div><div>${VERSION} · iPad Mini · 1024 × 768</div></div></header><section class="cards">${cardHtml}</section><section class="heat"><div>↻ Wärmepumpe</div><div><span>LÄUFT</span><b class="${heatpumpOn ? 'on' : ''}">${heatpumpOn ? 'JA' : 'NEIN'}</b></div><div><span>HEIZT</span><b class="${heating ? 'on' : ''}">${heating ? 'JA' : 'NEIN'}</b></div><div><span>DREHZAHL</span><b>${fan === null ? '--' : `${Math.round(fan)} %`}</b></div></section><footer class="schedule"><div class="schedule-label">Nächste Schaltungen</div><div class="schedule-list">${scheduleHtml(data.nextActionsText)}</div></footer></main><script data-ipad-final="1">(function(){var ns=${namespace};function api(){try{if(window.vis)return window.vis}catch(e){}try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}return null}async function setState(id,value){var v=api();try{if(v&&typeof v.setValue==='function'){var r=v.setValue(id,value);if(r&&typeof r.then==='function')await r;return true}}catch(e){}try{if(v&&v.conn&&typeof v.conn.setState==='function'){var q=v.conn.setState(id,value);if(q&&q.then==='function')await q;return true}}catch(e){}return false}document.addEventListener('click',async function(event){var button=event.target&&event.target.closest?event.target.closest('[data-dose]'):null;if(!button||button.disabled)return;event.preventDefault();event.stopPropagation();var old=button.innerHTML;button.disabled=true;button.innerHTML='<b>…</b><small>Start Dosierung</small>';var seconds=Number(button.dataset.dose)||60;var ok=await setState(ns+'.control.ph.manualDoseSec',seconds);if(ok)ok=await setState(ns+'.control.ph.manualTrigger',Date.now());button.innerHTML=ok?'<b>OK</b><small>Dosierung gestartet</small>':'<b>Fehler</b><small>nicht gestartet</small>';setTimeout(function(){button.innerHTML=old;button.disabled=false},1400)},true)})();</script>`;
}

async function parseStateJson(adapter, localId, fallback) {
  try {
    let state = await adapter.getStateAsync(localId);
    if (!state && typeof adapter.getForeignStateAsync === 'function') state = await adapter.getForeignStateAsync(`${adapter.namespace}.${localId}`);
    const parsed = JSON.parse(String((state && state.val) || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function loadHistory(adapter) {
  const local = await parseStateJson(adapter, 'status.trend.ipadMiniLocal24hJson', {});
  const [water, ph, orp] = await Promise.all([
    parseStateJson(adapter, 'status.trend.poolTemp24hJson', []),
    parseStateJson(adapter, 'status.trend.phTodayJson', []),
    parseStateJson(adapter, 'status.trend.orpTodayJson', [])
  ]);
  return {
    outside: Array.isArray(local.outside) ? local.outside : [],
    water: Array.isArray(local.water) && local.water.length ? local.water : water,
    ph: Array.isArray(local.ph) && local.ph.length ? local.ph : ph,
    orp: Array.isArray(local.orp) && local.orp.length ? local.orp : orp
  };
}

function install(adapter) {
  if (!adapter || adapter.__ipadFinalInstalled) return adapter;
  adapter.__ipadFinalInstalled = true;
  adapter.__ipadFinalData = null;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      if (name === 'buildTabletHtml') adapter.__ipadFinalData = { ...(data || {}), namespace: adapter.namespace };
      return String(original({ ...(data || {}), adapterVersion: VERSION })).replace(/v0\.4\.\d+/g, VERSION);
    };
  }

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    const data = adapter.__ipadFinalData;
    if (!data) return result;
    try {
      const history = await loadHistory(adapter);
      let html = '';
      for (const points of [28, 22, 16, 12]) {
        const candidate = buildHtml(data, history, points);
        if (Buffer.byteLength(candidate, 'utf8') <= MAX_HTML_BYTES) {
          html = candidate;
          break;
        }
      }
      if (!html || !html.includes('data-dose="60"') || !html.includes('data-ipad-final="1"')) throw new Error('kompakte iPad-Seite konnte nicht vollständig erzeugt werden');
      await adapter.setStateIfChanged(STATE_ID, html, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') adapter.log.warn('[IPAD-MINI] Finaler Renderer fehlgeschlagen: ' + (error.message || error));
    }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [1800, 5000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
          await adapter.forceImmediateRender();
        } catch (error) {
          if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') adapter.log.warn('[IPAD-MINI] Finaler Start-Render fehlgeschlagen: ' + (error.message || error));
        }
      }, delay));
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

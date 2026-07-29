'use strict';

const createDashboardAdapter = require('./main-ipadmini.js');

const ADAPTER_VERSION = 'v0.4.43';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';

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
  return parsed === null ? '--' : parsed.toFixed(digits).replace('.', ',');
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
  const rows = String(text || '--').split(/\n+/).map(row => row.trim()).filter(Boolean).slice(0, 4);
  if (!rows.length || rows[0] === '--') return '<span class="schedule-empty">Keine kommenden Schaltungen</span>';
  return rows.map(row => `<span class="schedule-chip">${esc(row)}</span>`).join('');
}

function manualDoseHtml() {
  return `<div class="ph-manual-dose" aria-label="pH manuelle Dosierung">
    <button type="button" data-ph-dose="60"><b>60 Sek.</b><small>Start Dosierung</small></button>
    <button type="button" data-ph-dose="120"><b>120 Sek.</b><small>Start Dosierung</small></button>
    <button type="button" data-ph-dose="180"><b>180 Sek.</b><small>Start Dosierung</small></button>
  </div>`;
}

function buildReadableHtml(data) {
  const cards = [
    { key: 'outside', label: 'Außentemperatur', value: data.outsideTemp, digits: 1, unit: '°C', color: '#58baff', icon: 'outside', trend: data.outsideTempTrend },
    { key: 'water', label: 'Wassertemperatur', value: data.poolTemp, digits: 1, unit: '°C', color: '#57dfdc', icon: 'water', trend: data.poolTempTrend },
    { key: 'ph', label: 'pH-Wert', value: data.ph, digits: 2, unit: '', color: data.phInRange ? '#67df7e' : '#ffbd59', icon: 'ph', trend: data.phTrend },
    { key: 'orp', label: 'ORP-Wert', value: data.orp, digits: 0, unit: 'mV', color: data.orpInRange ? '#67df7e' : '#ff9f59', icon: 'orp', trend: data.orpTrend }
  ];

  const cardHtml = cards.map(card => `<section class="metric-card" style="--accent:${card.color}">
    <div class="metric-head"><span class="metric-icon">${iconSvg(card.icon)}</span><span class="metric-label">${esc(card.label)}</span><span class="metric-period">24 Stunden</span></div>
    <div class="metric-reading"><span class="metric-value">${esc(formatValue(card.value, card.digits))}</span>${card.unit ? `<span class="metric-unit">${esc(card.unit)}</span>` : ''}<span class="metric-trend ${trendClass(card.trend)}">${esc(card.trend || '→')}</span></div>
    ${card.key === 'ph' ? manualDoseHtml() : ''}
    <div class="history-wrap"><div class="history-empty">History sammelt noch Daten</div></div>
    <div class="history-meta"><span>Min --${card.unit ? ` ${esc(card.unit)}` : ''}</span><span>Max --${card.unit ? ` ${esc(card.unit)}` : ''}</span></div>
  </section>`).join('');

  const namespace = JSON.stringify(String(data.namespace || 'poolsteuerung.0'));
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><title>Pool iPad Mini</title><style>
:root{--bg:#06111e;--line:rgba(255,255,255,.10);--text:#f6fbff;--muted:#9bb0c8;--green:#67df7e;--orange:#ffbd59}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg)}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--text)}.screen{width:100vw;height:100vh;padding:10px 12px;display:grid;grid-template-rows:40px minmax(0,1fr) 42px;gap:8px;background:radial-gradient(circle at 10% -10%,rgba(53,145,230,.20),transparent 35%),linear-gradient(145deg,#06101c,#0a1a2c 58%,#07131f)}.header{display:flex;align-items:center;justify-content:space-between;padding:0 4px}.brand{display:flex;align-items:center;gap:9px}.brand-icon{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(145deg,#228bd8,#28c8c0)}.brand-icon svg{width:19px;height:19px;fill:none;stroke:#fff;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.brand-title{font-size:21px;font-weight:900;letter-spacing:.08em}.brand-sub{font-size:9px;color:var(--muted);font-weight:700;letter-spacing:.11em;text-transform:uppercase}.header-meta{text-align:right;font-size:9px;color:var(--muted);line-height:1.3}.cards{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:8px;min-height:0}.metric-card{position:relative;min-width:0;min-height:0;overflow:hidden;border:1px solid var(--line);border-radius:17px;padding:13px 15px 10px;background:linear-gradient(150deg,rgba(17,40,65,.98),rgba(8,24,41,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 9px 22px rgba(0,0,0,.18)}.metric-card:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--accent)}.metric-head{height:30px;display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:8px}.metric-icon{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.08)}.metric-icon svg{width:17px;height:17px;fill:none;stroke:var(--accent);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.metric-label{font-size:17px;font-weight:850;color:#e7f1fb}.metric-period{font-size:9px;color:var(--muted);font-weight:750;text-transform:uppercase;letter-spacing:.06em}.metric-reading{height:92px;display:flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap}.metric-value{font-size:82px;font-weight:900;line-height:.88;letter-spacing:-.055em;color:var(--accent);font-variant-numeric:tabular-nums}.metric-unit{font-size:27px;font-weight:850;color:rgba(247,251,255,.80)}.metric-trend{font-size:31px;font-weight:900}.metric-trend.up{color:var(--green)}.metric-trend.down{color:var(--orange)}.metric-trend.flat{color:#afbed0}.history-wrap{height:105px;border-radius:10px;overflow:hidden;background:rgba(3,14,25,.30)}.history-svg{display:block;width:100%;height:100%}.grid-line{stroke:rgba(255,255,255,.07);stroke-width:1}.history-empty{height:100%;display:grid;place-items:center;color:var(--muted);font-size:12px;font-weight:700}.history-meta{height:20px;display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:10px;font-weight:750;padding-top:4px}.ph-manual-dose{position:absolute;left:15px;top:121px;z-index:8;display:flex;gap:5px}.ph-manual-dose button{width:63px;height:29px;padding:2px 4px;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:linear-gradient(180deg,#2d4f86,#162d52);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 5px 12px rgba(6,24,44,.28);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer}.ph-manual-dose b{font-size:9px;line-height:10px}.ph-manual-dose small{font-size:6px;line-height:7px;color:#dbeafe}.ph-manual-dose button:active{transform:translateY(1px)}.ph-manual-dose button:disabled{opacity:.6}.schedule{border:1px solid var(--line);border-radius:13px;background:rgba(10,28,47,.96);display:grid;grid-template-columns:auto 1fr;align-items:center;gap:10px;padding:6px 10px;overflow:hidden}.schedule-label{font-size:10px;color:var(--muted);font-weight:900;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}.schedule-list{display:flex;justify-content:flex-end;gap:6px;overflow:hidden}.schedule-chip{max-width:27%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(84,200,255,.17);background:rgba(84,200,255,.09);border-radius:999px;padding:5px 8px;font-size:9px;color:#deedff;font-weight:750}.schedule-empty{font-size:10px;color:var(--muted)}@media(max-width:900px){.metric-value{font-size:70px}.metric-label{font-size:15px}.history-wrap{height:92px}.ph-manual-dose{left:12px;top:114px}.ph-manual-dose button{width:56px;height:26px}.ph-manual-dose b{font-size:8px}.ph-manual-dose small{font-size:5px}}
</style></head><body><main class="screen"><header class="header"><div class="brand"><span class="brand-icon">${iconSvg('water')}</span><div><div class="brand-title">POOL</div><div class="brand-sub">24h Live-Verlauf</div></div></div><div class="header-meta"><div>${esc(data.updated || '--')}</div><div>${ADAPTER_VERSION} · iPad Mini · 1024 × 768</div></div></header><section class="cards">${cardHtml}</section><footer class="schedule"><div class="schedule-label">Nächste Schaltungen</div><div class="schedule-list">${scheduleHtml(data.nextActionsText)}</div></footer></main><script>(function(){var ns=${namespace};function api(){try{if(window.vis)return window.vis}catch(e){}try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}return null}async function setState(id,value){var v=api();try{if(v&&typeof v.setValue==='function'){var r=v.setValue(id,value);if(r&&typeof r.then==='function')await r;return true}}catch(e){}try{if(v&&v.conn&&typeof v.conn.setState==='function'){var q=v.conn.setState(id,value);if(q&&typeof q.then==='function')await q;return true}}catch(e){}return false}document.addEventListener('click',async function(event){var button=event.target&&event.target.closest?event.target.closest('[data-ph-dose]'):null;if(!button||button.disabled)return;event.preventDefault();event.stopPropagation();var old=button.innerHTML;button.disabled=true;button.innerHTML='<b>…</b><small>Start Dosierung</small>';var seconds=Number(button.dataset.phDose)||60;var ok=await setState(ns+'.control.ph.manualDoseSec',seconds);if(ok)ok=await setState(ns+'.control.ph.manualTrigger',Date.now());button.innerHTML=ok?'<b>OK</b><small>Dosierung gestartet</small>':'<b>Fehler</b><small>nicht gestartet</small>';setTimeout(function(){button.innerHTML=old;button.disabled=false},1400)},true)})();</script></body></html>`;
}

function installReadableIpadMini(adapter) {
  if (!adapter || adapter.__readableIpadMiniInstalled) return adapter;
  adapter.__readableIpadMiniInstalled = true;
  adapter.__readableIpadMiniData = null;

  const originalTabletBuilder = adapter.buildTabletHtml.bind(adapter);
  adapter.buildTabletHtml = function captureReadableData(data) {
    adapter.__readableIpadMiniData = { ...(data || {}), namespace: adapter.namespace };
    return String(originalTabletBuilder({ ...(data || {}), adapterVersion: ADAPTER_VERSION })).replace(/v0\.4\.\d+/g, ADAPTER_VERSION);
  };

  for (const methodName of ['buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = data => String(original({ ...(data || {}), adapterVersion: ADAPTER_VERSION })).replace(/v0\.4\.\d+/g, ADAPTER_VERSION);
  }

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async function renderReadableIpadMini(force = false) {
    await this.ensureState(IPAD_MINI_STATE, 'string', 'html', '', false);
    const result = await baseRenderVisFull(force);
    const data = this.__readableIpadMiniData;
    if (data) await this.setStateIfChanged(IPAD_MINI_STATE, buildReadableHtml(data), true);
    return result;
  };

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState(IPAD_MINI_STATE, 'string', 'html', '', false);
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        await adapter.forceImmediateRender();
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) adapter.log.warn('[IPAD-MINI] Start der Ansicht fehlgeschlagen: ' + (error.message || error));
      }
    }, 2200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return installReadableIpadMini(createDashboardAdapter(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

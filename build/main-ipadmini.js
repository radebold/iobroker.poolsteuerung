'use strict';

const createWeightAdapter = require('./main-weight.js');

const ADAPTER_VERSION = 'v0.4.7';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deValue(value, digits = null) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(parsed)) return '--';
  const formatted = digits === null ? String(value) : parsed.toFixed(digits);
  return formatted.replace('.', ',');
}

function trendClass(value) {
  if (value === '↑') return 'up';
  if (value === '↓') return 'down';
  return 'flat';
}

function scheduleItems(text) {
  const rows = String(text || '--')
    .split(/\n+/)
    .map(row => row.trim())
    .filter(Boolean)
    .slice(0, 4);

  if (!rows.length || (rows.length === 1 && rows[0] === '--')) {
    return '<span class="schedule-empty">Keine kommenden Schaltungen</span>';
  }

  return rows.map(row => `<span class="schedule-chip">${esc(row)}</span>`).join('');
}

function buildIpadMiniHtml(data = {}) {
  const phOk = data.phInRange === true;
  const orpOk = data.orpInRange === true;

  const tile = ({ label, value, unit, accent, trend, stateClass = '' }) => `
    <section class="tile ${accent} ${stateClass}">
      <div class="tile-label">${esc(label)}</div>
      <div class="tile-reading">
        <span class="tile-value">${esc(value)}</span>
        ${unit ? `<span class="tile-unit">${esc(unit)}</span>` : ''}
        ${trend ? `<span class="tile-trend ${trendClass(trend)}">${esc(trend)}</span>` : ''}
      </div>
    </section>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
  <title>Pool iPad Mini</title>
  <style>
    :root{
      --bg:#07111e;
      --panel:#0e1d31;
      --line:rgba(255,255,255,.09);
      --text:#f7fbff;
      --muted:#8fa5bf;
      --blue:#54c8ff;
      --cyan:#6be0ff;
      --green:#5fe27c;
      --orange:#ffbd59;
      --red:#ff746b;
    }
    *{box-sizing:border-box}
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg)}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--text);-webkit-user-select:none;user-select:none}
    .screen{
      width:100vw;
      height:100vh;
      min-height:100%;
      padding:max(12px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left));
      display:grid;
      grid-template-rows:46px minmax(0,1fr) 48px;
      gap:8px;
      background:
        radial-gradient(circle at 15% 0%,rgba(48,130,210,.15),transparent 34%),
        radial-gradient(circle at 100% 100%,rgba(64,210,210,.08),transparent 35%),
        linear-gradient(145deg,#07111e,#09182a 58%,#07111e);
    }
    .header{display:flex;align-items:center;justify-content:space-between;padding:0 5px}
    .title{display:flex;align-items:baseline;gap:10px}
    .title-main{font-size:23px;font-weight:850;letter-spacing:.06em}
    .title-sub{font-size:11px;color:var(--muted);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    .header-meta{text-align:right;color:var(--muted);font-size:10px;line-height:1.3}
    .grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:8px;min-height:0}
    .tile{
      position:relative;
      min-width:0;
      min-height:0;
      border:1px solid var(--line);
      border-radius:16px;
      padding:15px 18px;
      display:flex;
      flex-direction:column;
      justify-content:center;
      overflow:hidden;
      background:linear-gradient(145deg,rgba(18,38,63,.98),rgba(10,25,43,.98));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 8px 20px rgba(0,0,0,.17);
    }
    .tile:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--accent);opacity:.9}
    .tile.temp-out{--accent:var(--blue)}
    .tile.temp-water{--accent:var(--cyan)}
    .tile.ph{--accent:${phOk ? 'var(--green)' : 'var(--orange)'}}
    .tile.orp{--accent:${orpOk ? 'var(--green)' : 'var(--orange)'}}
    .tile-label{position:absolute;top:14px;left:18px;color:var(--muted);font-size:18px;font-weight:800;letter-spacing:.035em}
    .tile-reading{display:flex;align-items:baseline;justify-content:center;gap:8px;white-space:nowrap;padding-top:13px;min-width:0}
    .tile-value{font-size:clamp(68px,9.2vw,96px);font-weight:900;line-height:.88;letter-spacing:-.055em;color:var(--accent);font-variant-numeric:tabular-nums}
    .tile-unit{font-size:30px;font-weight:850;color:rgba(247,251,255,.78)}
    .tile-trend{font-size:34px;font-weight:900;margin-left:2px}
    .tile-trend.up{color:var(--green)}
    .tile-trend.down{color:var(--orange)}
    .tile-trend.flat{color:#aebdd0}
    .schedule{
      border:1px solid var(--line);
      border-radius:14px;
      background:rgba(13,29,49,.94);
      display:grid;
      grid-template-columns:auto 1fr;
      align-items:center;
      gap:12px;
      padding:7px 12px;
      min-width:0;
      overflow:hidden;
    }
    .schedule-label{color:var(--muted);font-size:10px;font-weight:850;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
    .schedule-list{display:flex;justify-content:flex-end;gap:6px;min-width:0;overflow:hidden}
    .schedule-chip{background:rgba(84,200,255,.10);border:1px solid rgba(84,200,255,.18);border-radius:999px;padding:5px 8px;font-size:9px;font-weight:750;color:#ddecff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:27%}
    .schedule-empty{color:var(--muted);font-size:10px;font-weight:700}

    /* Zielauflösung iPad Mini im Querformat: ungefähr 1024 × 768 CSS-Pixel. */
    @media (min-width:900px) and (max-width:1100px) and (min-height:650px) and (max-height:850px){
      .screen{padding:12px 14px 10px;grid-template-rows:44px minmax(0,1fr) 46px;gap:8px}
      .grid{gap:8px}
      .tile{border-radius:15px;padding:14px 17px}
      .tile-label{top:13px;left:17px;font-size:17px}
      .tile-value{font-size:94px}
      .tile-unit{font-size:29px}
      .tile-trend{font-size:33px}
    }

    @media (orientation:portrait){
      .screen{grid-template-rows:44px minmax(0,1fr) 60px;padding:10px}
      .grid{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:7px}
      .tile{padding:13px}
      .tile-label{top:12px;left:14px;font-size:15px}
      .tile-value{font-size:clamp(54px,12vw,82px)}
      .tile-unit{font-size:24px}
      .tile-trend{font-size:28px}
      .schedule{grid-template-columns:1fr;gap:3px}
      .schedule-list{justify-content:flex-start}
      .schedule-chip{max-width:46%}
    }
  </style>
</head>
<body>
  <main class="screen">
    <header class="header">
      <div class="title"><span class="title-main">POOL</span><span class="title-sub">Übersicht</span></div>
      <div class="header-meta"><div>${esc(data.updated || '--')}</div><div>${ADAPTER_VERSION} · iPad Mini · 1024 × 768</div></div>
    </header>

    <div class="grid">
      ${tile({ label:'Außentemperatur', value:deValue(data.outsideTemp,1), unit:'°C', accent:'temp-out', trend:data.outsideTempTrend || '' })}
      ${tile({ label:'Wassertemperatur', value:deValue(data.poolTemp,1), unit:'°C', accent:'temp-water', trend:data.poolTempTrend || '' })}
      ${tile({ label:'pH-Wert', value:deValue(data.ph,2), unit:'', accent:'ph', trend:data.phTrend || '', stateClass:phOk ? 'ok' : 'warn' })}
      ${tile({ label:'ORP-Wert', value:deValue(data.orp,0), unit:'mV', accent:'orp', trend:data.orpTrend || '', stateClass:orpOk ? 'ok' : 'warn' })}
    </div>

    <footer class="schedule">
      <div class="schedule-label">Nächste Schaltungen</div>
      <div class="schedule-list">${scheduleItems(data.nextActionsText)}</div>
    </footer>
  </main>
</body>
</html>`;
}

function installIpadMiniDashboard(adapter) {
  if (!adapter || adapter.__ipadMiniDashboardInstalled) return adapter;
  adapter.__ipadMiniDashboardInstalled = true;
  adapter.__ipadMiniDashboardData = null;

  const builders = ['buildTabletHtml','buildPhoneHtml','buildTabletWidget','buildPhoneWidget'];
  for (const methodName of builders) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchedBuilder(data) {
      if (methodName === 'buildTabletHtml') adapter.__ipadMiniDashboardData = { ...(data || {}) };
      const html = original({ ...(data || {}), adapterVersion:ADAPTER_VERSION });
      return String(html || '').replace(/v0\.4\.6/g,ADAPTER_VERSION).replace(/v0\.4\.5/g,ADAPTER_VERSION);
    };
  }

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async function renderVisFullWithIpadMini(force = false) {
    await this.ensureState(IPAD_MINI_STATE,'string','html','',false);
    const result = await baseRenderVisFull(force);
    const data = this.__ipadMiniDashboardData;
    if (data) {
      const html = buildIpadMiniHtml(data);
      await this.setStateIfChanged(IPAD_MINI_STATE,html,true);
    }
    return result;
  };

  adapter.on('ready',() => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState(IPAD_MINI_STATE,'string','html','',false);
        await adapter.forceImmediateRender();
      } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Initialisierung fehlgeschlagen: ' + (error.message || error));
      }
    },2500));
  });

  try {
    adapter.log.info('[IPAD-MINI] v0.4.7: Vollbildseite für 1024x768 optimiert');
  } catch {}

  return adapter;
}

function createAdapter(options = {}) {
  return installIpadMiniDashboard(createWeightAdapter(options));
}

if (require.main !== module) {
  module.exports = createAdapter;
} else {
  createAdapter();
}

'use strict';

const createHistoryAdapter = require('./main-ipadmini-historyfix.js');

const ADAPTER_VERSION = 'v0.4.29';
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
  if (value === undefined || value === null || value === '') return null;
  const number = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function deNumber(value, digits) {
  const number = numberValue(value);
  return number === null ? '--' : number.toFixed(digits).replace('.', ',');
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'on', 'ein', 'yes', 'ja', 'active', 'aktiv'].includes(text)) return true;
  if (['false', '0', 'off', 'aus', 'no', 'nein', 'inactive', 'inaktiv', ''].includes(text)) return false;
  return !!value;
}

function heatingInfo(isRunning, modeValue) {
  if (!isRunning) return { text: 'NEIN', cls: 'off' };

  const mode = String(modeValue ?? '').trim().toLowerCase();
  if (/(heiz|heat|warm)/.test(mode)) return { text: 'JA', cls: 'heat' };
  if (/(kühl|kuehl|cool|lüft|lueft|fan|dry|entfeucht)/.test(mode)) return { text: 'NEIN', cls: 'off' };
  return { text: '—', cls: 'neutral' };
}

function speedText(value) {
  const text = String(value ?? '').trim();
  const match = text.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return '--';
  const number = Number(match[0]);
  if (!Number.isFinite(number)) return '--';
  return `${Math.round(number)} %`;
}

function heatpumpIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.2"/><path d="M12 3.2c2.3 0 3.7 1.4 3.7 3.1 0 2.6-2.5 4.2-3.7 5.7M20.8 12c0 2.3-1.4 3.7-3.1 3.7-2.6 0-4.2-2.5-5.7-3.7M12 20.8c-2.3 0-3.7-1.4-3.7-3.1 0-2.6 2.5-4.2 3.7-5.7M3.2 12c0-2.3 1.4-3.7 3.1-3.7 2.6 0 4.2 2.5 5.7 3.7"/></svg>';
}

function canisterIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8v3l2 2v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8l2-2V3Z"/><path d="M9 3h6M9 11h6M12 14v4M10 16h4"/></svg>';
}

function canisterInfo(data = {}) {
  const canister = data.phCanister || {};
  const available = canister.available !== false && numberValue(canister.levelL) !== null;
  if (!available) {
    return { primary: 'NICHT VERFÜGBAR', secondary: '', cls: 'critical' };
  }

  const level = numberValue(canister.levelL);
  const percent = numberValue(canister.percent);
  const scaleEnabled = canister.scaleEnabled === true;
  const cls = canister.critical ? 'critical' : (canister.warn ? 'warn' : 'ok');

  if (scaleEnabled) {
    return {
      primary: `${deNumber(level, 3)} kg`,
      secondary: `≈ ${deNumber(level, 2)} l${percent === null ? '' : ` · ${deNumber(percent, 0)} %`}`,
      cls
    };
  }

  return {
    primary: `${deNumber(level, 2)} l`,
    secondary: percent === null ? '' : `${deNumber(percent, 0)} %`,
    cls
  };
}

function buildHeatpumpStrip(data = {}) {
  const running = boolValue(data.heatpumpOn);
  const heating = heatingInfo(running, data.heatpumpMode);
  const speed = speedText(data.heatpumpFanPercent);
  const canister = canisterInfo(data);

  return `<section class="heatpump-strip" data-heatpump-strip="1">
    <div class="heatpump-title">
      <span class="heatpump-icon">${heatpumpIcon()}</span>
      <span>Wärmepumpe</span>
    </div>
    <div class="heatpump-item">
      <span class="heatpump-dot ${running ? 'on' : 'off'}"></span>
      <span class="heatpump-key">Läuft</span>
      <strong class="heatpump-value ${running ? 'on' : 'off'}">${running ? 'JA' : 'NEIN'}</strong>
    </div>
    <div class="heatpump-item">
      <span class="heatpump-dot ${heating.cls}"></span>
      <span class="heatpump-key">Heizt</span>
      <strong class="heatpump-value ${heating.cls}">${heating.text}</strong>
    </div>
    <div class="heatpump-item">
      <span class="heatpump-dot speed"></span>
      <span class="heatpump-key">Drehzahl</span>
      <strong class="heatpump-value speed">${esc(speed)}</strong>
    </div>
    <div class="canister-item ${canister.cls}">
      <span class="canister-icon">${canisterIcon()}</span>
      <span class="canister-key">pH-Minus</span>
      <span class="canister-values"><strong>${esc(canister.primary)}</strong>${canister.secondary ? `<small>${esc(canister.secondary)}</small>` : ''}</span>
    </div>
  </section>`;
}

function patchHeatpumpHtml(html, data) {
  let value = String(html || '');
  if (!value || !value.includes('<footer class="schedule">')) return value;

  value = value
    .replace(/<style data-ipad-heatpump="1">[\s\S]*?<\/style>/g, '')
    .replace(/<section class="heatpump-strip" data-heatpump-strip="1">[\s\S]*?<\/section>/g, '')
    .replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28)/g, ADAPTER_VERSION);

  const css = `<style data-ipad-heatpump="1">
.screen{grid-template-rows:40px minmax(0,1fr) 44px 42px!important}
.heatpump-strip{min-width:0;overflow:hidden;border:1px solid rgba(255,255,255,.10);border-radius:13px;background:linear-gradient(145deg,rgba(15,37,60,.98),rgba(8,25,42,.98));display:grid;grid-template-columns:1.08fr .72fr .72fr .9fr 1.58fr;align-items:center;gap:4px;padding:5px 8px;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.heatpump-title{display:flex;align-items:center;gap:7px;color:#e9f4ff;font-size:11px;font-weight:900;white-space:nowrap}.heatpump-icon{width:27px;height:27px;border-radius:9px;display:grid;place-items:center;background:rgba(84,200,255,.10);border:1px solid rgba(84,200,255,.18)}.heatpump-icon svg{width:17px;height:17px;fill:none;stroke:#67d9ff;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.heatpump-item{min-width:0;height:30px;display:grid;grid-template-columns:7px auto 1fr;align-items:center;gap:5px;padding:0 6px;border-left:1px solid rgba(255,255,255,.07)}.heatpump-dot{width:7px;height:7px;border-radius:50%;background:#74869b;box-shadow:0 0 8px rgba(116,134,155,.25)}.heatpump-dot.on,.heatpump-dot.heat{background:#67df7e;box-shadow:0 0 9px rgba(103,223,126,.45)}.heatpump-dot.off{background:#77899c}.heatpump-dot.speed{background:#58baff;box-shadow:0 0 9px rgba(88,186,255,.4)}
.heatpump-key{color:#9bb0c8;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}.heatpump-value{justify-self:end;color:#dbe9f6;font-size:11px;font-weight:900;white-space:nowrap}.heatpump-value.on,.heatpump-value.heat{color:#67df7e}.heatpump-value.off{color:#aab9c8}.heatpump-value.speed{color:#69c4ff}.heatpump-value.neutral{color:#d1dce7}
.canister-item{min-width:0;height:34px;display:grid;grid-template-columns:26px auto 1fr;align-items:center;gap:6px;padding:2px 7px;border-left:1px solid rgba(255,255,255,.08);border-radius:9px;background:rgba(255,255,255,.035)}.canister-icon{width:25px;height:25px;border-radius:8px;display:grid;place-items:center;background:rgba(164,124,255,.12);border:1px solid rgba(164,124,255,.2)}.canister-icon svg{width:16px;height:16px;fill:none;stroke:#b99aff;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.canister-key{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#b9c9db;white-space:nowrap}.canister-values{min-width:0;justify-self:end;text-align:right;line-height:1.02}.canister-values strong{display:block;font-size:12px;color:#7ee493;white-space:nowrap}.canister-values small{display:block;margin-top:2px;font-size:8px;color:#aabbd0;white-space:nowrap}.canister-item.warn .canister-values strong{color:#ffc15f}.canister-item.warn .canister-icon{background:rgba(255,177,62,.12);border-color:rgba(255,177,62,.25)}.canister-item.warn .canister-icon svg{stroke:#ffc15f}.canister-item.critical .canister-values strong{color:#ff8175}.canister-item.critical .canister-icon{background:rgba(255,100,88,.12);border-color:rgba(255,100,88,.25)}.canister-item.critical .canister-icon svg{stroke:#ff8175}
@media(max-width:900px){.heatpump-strip{grid-template-columns:.95fr .63fr .63fr .78fr 1.48fr;padding:5px 5px;gap:2px}.heatpump-title{font-size:9px;gap:4px}.heatpump-icon{width:23px;height:23px}.heatpump-item{padding:0 3px;gap:3px}.heatpump-key{font-size:7px}.heatpump-value{font-size:9px}.canister-item{grid-template-columns:22px auto 1fr;gap:4px;padding:2px 4px}.canister-icon{width:21px;height:21px}.canister-key{font-size:7px}.canister-values strong{font-size:10px}.canister-values small{font-size:7px}}
</style>`;

  value = value.includes('</head>') ? value.replace('</head>', `${css}</head>`) : css + value;
  return value.replace('<footer class="schedule">', `${buildHeatpumpStrip(data)}<footer class="schedule">`);
}

function installHeatpumpStrip(adapter) {
  if (!adapter || adapter.__ipadMiniHeatpumpInstalled) return adapter;
  adapter.__ipadMiniHeatpumpInstalled = true;
  adapter.__ipadMiniHeatpumpData = null;

  const originalTabletBuilder = adapter.buildTabletHtml.bind(adapter);
  adapter.buildTabletHtml = function captureHeatpumpData(data) {
    adapter.__ipadMiniHeatpumpData = { ...(data || {}) };
    return String(originalTabletBuilder({ ...(data || {}), adapterVersion: ADAPTER_VERSION }))
      .replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28)/g, ADAPTER_VERSION);
  };

  for (const methodName of ['buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchVersion(data) {
      return String(original({ ...(data || {}), adapterVersion: ADAPTER_VERSION }))
        .replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28)/g, ADAPTER_VERSION);
    };
  }

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async function renderWithHeatpumpStrip(force = false) {
    const result = await baseRenderVisFull(force);
    const data = this.__ipadMiniHeatpumpData;
    if (!data) return result;

    try {
      const state = await this.getStateAsync(IPAD_MINI_STATE);
      if (state && typeof state.val === 'string' && state.val.length > 50) {
        const html = patchHeatpumpHtml(state.val, data);
        await this.setStateIfChanged(IPAD_MINI_STATE, html, true);
      }
    } catch (error) {
      if (!this.isDbClosedError(error)) this.log.warn('[IPAD-MINI] Statusleiste konnte nicht aktualisiert werden: ' + (error.message || error));
    }
    return result;
  };

  try {
    adapter.log.info('[IPAD-MINI] v0.4.29: Wärmepumpe und pH-Minus-Kanisterstand aktiv');
  } catch {}

  return adapter;
}

function createAdapter(options = {}) {
  return installHeatpumpStrip(createHistoryAdapter(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();
'use strict';

const createHistoryAdapter = require('./main-ipadmini-historyfix.js');

const ADAPTER_VERSION = 'v0.4.30';
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

function canisterInfo(data = {}) {
  const canister = data.phCanister || {};
  const available = canister.available !== false && numberValue(canister.levelL) !== null;
  if (!available) {
    return { primary: 'Nicht verfügbar', secondary: '', cls: 'critical' };
  }

  const level = numberValue(canister.levelL);
  const percent = numberValue(canister.percent);
  const scaleEnabled = canister.scaleEnabled === true;
  const cls = canister.critical ? 'critical' : (canister.warn ? 'warn' : 'ok');

  if (scaleEnabled) {
    return {
      primary: `≈ ${deNumber(level, 2)} l`,
      secondary: `${deNumber(level, 3)} kg${percent === null ? '' : ` · ${deNumber(percent, 0)} %`}`,
      cls
    };
  }

  return {
    primary: `${deNumber(level, 2)} l`,
    secondary: percent === null ? '' : `${deNumber(percent, 0)} %`,
    cls
  };
}

function buildCanisterBadge(data = {}) {
  const canister = canisterInfo(data);
  return `<span class="ph-canister-badge ${canister.cls}" data-ph-canister="1">
    <small>pH-Minus</small>
    <strong>${esc(canister.primary)}</strong>
    ${canister.secondary ? `<em>${esc(canister.secondary)}</em>` : ''}
  </span>`;
}

function buildHeatpumpStrip(data = {}) {
  const running = boolValue(data.heatpumpOn);
  const heating = heatingInfo(running, data.heatpumpMode);
  const speed = speedText(data.heatpumpFanPercent);

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
  </section>`;
}

function patchCanisterIntoPhCard(html, data) {
  const labelMarker = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = html.indexOf(labelMarker);
  if (labelIndex < 0) return html;

  const cardStart = html.lastIndexOf('<section class="metric-card"', labelIndex);
  const cardEnd = html.indexOf('</section>', labelIndex);
  if (cardStart < 0 || cardEnd < 0) return html;

  let card = html.slice(cardStart, cardEnd + 10);
  const periodMarker = '<span class="metric-period">24 Stunden</span>';
  if (!card.includes(periodMarker)) return html;

  card = card.replace(periodMarker, buildCanisterBadge(data));
  return html.slice(0, cardStart) + card + html.slice(cardEnd + 10);
}

function patchHeatpumpHtml(html, data) {
  let value = String(html || '');
  if (!value || !value.includes('<footer class="schedule">')) return value;

  value = value
    .replace(/<style data-ipad-heatpump="1">[\s\S]*?<\/style>/g, '')
    .replace(/<section class="heatpump-strip" data-heatpump-strip="1">[\s\S]*?<\/section>/g, '')
    .replace(/<span class="ph-canister-badge[^>]*" data-ph-canister="1">[\s\S]*?<\/span>/g, '<span class="metric-period">24 Stunden</span>')
    .replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29)/g, ADAPTER_VERSION);

  const css = `<style data-ipad-heatpump="1">
.screen{grid-template-rows:40px minmax(0,1fr) 42px 42px!important}
.heatpump-strip{min-width:0;overflow:hidden;border:1px solid rgba(255,255,255,.10);border-radius:13px;background:linear-gradient(145deg,rgba(15,37,60,.98),rgba(8,25,42,.98));display:grid;grid-template-columns:1.25fr repeat(3,minmax(0,1fr));align-items:center;gap:6px;padding:5px 10px;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.heatpump-title{display:flex;align-items:center;gap:8px;color:#e9f4ff;font-size:12px;font-weight:900;white-space:nowrap}.heatpump-icon{width:27px;height:27px;border-radius:9px;display:grid;place-items:center;background:rgba(84,200,255,.10);border:1px solid rgba(84,200,255,.18)}.heatpump-icon svg{width:17px;height:17px;fill:none;stroke:#67d9ff;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.heatpump-item{min-width:0;height:30px;display:grid;grid-template-columns:8px auto 1fr;align-items:center;gap:6px;padding:0 9px;border-left:1px solid rgba(255,255,255,.07)}.heatpump-dot{width:7px;height:7px;border-radius:50%;background:#74869b;box-shadow:0 0 8px rgba(116,134,155,.25)}.heatpump-dot.on,.heatpump-dot.heat{background:#67df7e;box-shadow:0 0 9px rgba(103,223,126,.45)}.heatpump-dot.off{background:#77899c}.heatpump-dot.speed{background:#58baff;box-shadow:0 0 9px rgba(88,186,255,.4)}
.heatpump-key{color:#9bb0c8;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}.heatpump-value{justify-self:end;color:#dbe9f6;font-size:12px;font-weight:900;white-space:nowrap}.heatpump-value.on,.heatpump-value.heat{color:#67df7e}.heatpump-value.off{color:#aab9c8}.heatpump-value.speed{color:#69c4ff}.heatpump-value.neutral{color:#d1dce7}
.ph-canister-badge{justify-self:end;min-width:142px;max-width:190px;height:30px;display:grid;grid-template-columns:auto auto;grid-template-rows:13px 13px;align-items:center;column-gap:7px;padding:2px 8px;border:1px solid rgba(164,124,255,.22);border-radius:9px;background:linear-gradient(145deg,rgba(164,124,255,.12),rgba(255,255,255,.035));line-height:1;overflow:hidden}.ph-canister-badge small{grid-column:1;grid-row:1;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#c7b7ef;white-space:nowrap}.ph-canister-badge strong{grid-column:1;grid-row:2;font-size:12px;font-style:normal;color:#7ee493;white-space:nowrap}.ph-canister-badge em{grid-column:2;grid-row:1 / span 2;align-self:center;justify-self:end;font-size:8px;font-style:normal;color:#aabbd0;white-space:nowrap}.ph-canister-badge.warn{border-color:rgba(255,177,62,.30);background:linear-gradient(145deg,rgba(255,177,62,.13),rgba(255,255,255,.035))}.ph-canister-badge.warn small,.ph-canister-badge.warn strong{color:#ffc15f}.ph-canister-badge.critical{border-color:rgba(255,100,88,.30);background:linear-gradient(145deg,rgba(255,100,88,.13),rgba(255,255,255,.035))}.ph-canister-badge.critical small,.ph-canister-badge.critical strong{color:#ff8175}
@media(max-width:900px){.heatpump-strip{grid-template-columns:1.1fr repeat(3,minmax(0,1fr));padding:5px 7px}.heatpump-title{font-size:10px}.heatpump-item{padding:0 5px;gap:4px}.heatpump-key{font-size:8px}.heatpump-value{font-size:10px}.ph-canister-badge{min-width:126px;max-width:155px;padding:2px 6px;column-gap:5px}.ph-canister-badge small{font-size:7px}.ph-canister-badge strong{font-size:10px}.ph-canister-badge em{font-size:7px}}
</style>`;

  value = value.includes('</head>') ? value.replace('</head>', `${css}</head>`) : css + value;
  value = patchCanisterIntoPhCard(value, data);
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
      .replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29)/g, ADAPTER_VERSION);
  };

  for (const methodName of ['buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchVersion(data) {
      return String(original({ ...(data || {}), adapterVersion: ADAPTER_VERSION }))
        .replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29)/g, ADAPTER_VERSION);
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
      if (!this.isDbClosedError(error)) this.log.warn('[IPAD-MINI] Statusleiste oder pH-Minus-Anzeige konnte nicht aktualisiert werden: ' + (error.message || error));
    }
    return result;
  };

  try {
    adapter.log.info('[IPAD-MINI] v0.4.30: pH-Minus-Stand innerhalb der pH-Kachel aktiv');
  } catch {}

  return adapter;
}

function createAdapter(options = {}) {
  return installHeatpumpStrip(createHistoryAdapter(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

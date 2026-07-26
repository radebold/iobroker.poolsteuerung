'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.17';

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function clickAttributes(namespace) {
  const inputId = `${namespace}.control.ph.calibration.poollabValue`;
  const triggerId = `${namespace}.control.ph.calibration.saveTrigger`;
  const code = `var v=prompt('PoolLab pH-Wert eingeben','');if(v===null)return false;v=Number(String(v).replace(',','.'));if(!Number.isFinite(v)||v<0||v>14){alert('Bitte einen gültigen pH-Wert eingeben.');return false;}if(typeof window.poolSetState!=='function'){alert('VIS setState nicht verfügbar.');return false;}Promise.resolve(window.poolSetState('${inputId}',v)).then(function(){return window.poolSetState('${triggerId}',Date.now());}).catch(function(){alert('PoolLab-Wert konnte nicht gespeichert werden.');});return false;`;
  return ` onclick="${escapeAttr(code)}" title="PoolLab-Wert erfassen" style="cursor:pointer;touch-action:manipulation"`;
}

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16)/g, VERSION);
}

function patchTabletHtml(html, namespace) {
  let result = patchVersion(html);
  const attrs = clickAttributes(namespace);
  result = result.replace(
    /(<div class="metric-label">pH<\/div>[\s\S]{0,1200}?<div class="metric-value")/,
    `$1${attrs}`
  );
  return result;
}

function patchTabletWidget(html, namespace) {
  let result = patchVersion(html);
  const attrs = clickAttributes(namespace);
  result = result.replace(
    /(<div class="ps-k">pH<\/div>[\s\S]{0,1200}?<div class="ps-v")/,
    `$1${attrs}`
  );
  return result;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationInlineInstalled) return adapter;
  adapter.__phCalibrationInlineInstalled = true;

  if (typeof adapter.buildTabletHtml === 'function') {
    const original = adapter.buildTabletHtml.bind(adapter);
    adapter.buildTabletHtml = data => patchTabletHtml(
      original({ ...(data || {}), adapterVersion: VERSION }),
      (data && data.namespace) || adapter.namespace
    );
  }

  if (typeof adapter.buildTabletWidget === 'function') {
    const original = adapter.buildTabletWidget.bind(adapter);
    adapter.buildTabletWidget = data => patchTabletWidget(
      original({ ...(data || {}), adapterVersion: VERSION }),
      (data && data.namespace) || adapter.namespace
    );
  }

  for (const methodName of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  try { adapter.log.info('[PH-KAL] v0.4.17: minimale PoolLab-Eingabe direkt am pH-Wert aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

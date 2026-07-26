'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.18';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17)/g, VERSION);
}

function eventCode(namespace) {
  const inputId = `${namespace}.control.ph.calibration.poollabValue`;
  const triggerId = `${namespace}.control.ph.calibration.saveTrigger`;
  return `(function(){var n=document.querySelectorAll('.js-ph-cal');for(var i=0;i<n.length;i++){(function(e){if(e.dataset.pc==='1')return;e.dataset.pc='1';e.style.cursor='pointer';e.style.touchAction='manipulation';e.addEventListener('click',function(x){x.preventDefault();x.stopPropagation();var s=window.prompt('PoolLab pH-Wert eingeben','');if(s===null)return;var v=Number(String(s).replace(',','.'));if(!Number.isFinite(v)||v<0||v>14){window.alert('Bitte einen gültigen PoolLab-pH-Wert eingeben.');return;}Promise.resolve(window.poolSetState('${inputId}',v)).then(function(ok){if(ok===false)throw new Error();return window.poolSetState('${triggerId}',Date.now());}).then(function(ok){if(ok===false)throw new Error();}).catch(function(){window.alert('PoolLab-Wert konnte nicht gespeichert werden.');});});})(n[i]);}})();`;
}

function addPhClass(html, widget) {
  if (widget) {
    return html.replace(
      /(<div class="ps-k">pH<\/div>[\s\S]{0,1200}?<div class=")ps-v(")/,
      '$1ps-v js-ph-cal$2'
    );
  }
  return html.replace(
    /(<div class="metric-label">pH<\/div>[\s\S]{0,1200}?<div class=")metric-value(")/,
    '$1metric-value js-ph-cal$2'
  );
}

function patchOutput(html, namespace, widget) {
  let result = addPhClass(patchVersion(html), widget);
  if (!result.includes('js-ph-cal') || result.includes("querySelectorAll('.js-ph-cal')")) return result;
  const code = eventCode(namespace);
  if (result.includes('</script></body>')) {
    return result.replace('</script></body>', `${code}</script></body>`);
  }
  if (result.includes('</body>')) {
    return result.replace('</body>', `<script>${code}</script></body>`);
  }
  return result;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationEventInstalled) return adapter;
  adapter.__phCalibrationEventInstalled = true;

  if (typeof adapter.buildTabletHtml === 'function') {
    const original = adapter.buildTabletHtml.bind(adapter);
    adapter.buildTabletHtml = data => patchOutput(
      original({ ...(data || {}), adapterVersion: VERSION }),
      (data && data.namespace) || adapter.namespace,
      false
    );
  }

  if (typeof adapter.buildTabletWidget === 'function') {
    const original = adapter.buildTabletWidget.bind(adapter);
    adapter.buildTabletWidget = data => patchOutput(
      original({ ...(data || {}), adapterVersion: VERSION }),
      (data && data.namespace) || adapter.namespace,
      true
    );
  }

  for (const methodName of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  try { adapter.log.info('[PH-KAL] v0.4.18: PoolLab-Eingabe über VIS-Eventhandler aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

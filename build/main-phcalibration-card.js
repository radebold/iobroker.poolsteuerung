'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.19';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18)/g, VERSION);
}

function eventCode(namespace) {
  const inputId = `${namespace}.control.ph.calibration.poollabValue`;
  const triggerId = `${namespace}.control.ph.calibration.saveTrigger`;
  return `(function(){if(window.__phCalCard19)return;window.__phCalCard19=1;var last=0;function text(v){return String(v||'').replace(/\\s+/g,' ').trim().toLowerCase()}function phCard(node){for(var i=0;node&&i<9;i++,node=node.parentElement){if(node.classList&&(node.classList.contains('ps-metric')||node.classList.contains('metric'))){var label=node.querySelector('.ps-k,.metric-label');if(label&&text(label.textContent)==='ph'){node.style.cursor='pointer';node.style.touchAction='manipulation';return node}}}return null}function dialog(){var w=window;try{if(window.top&&typeof window.top.prompt==='function')w=window.top}catch(e){}var value=w.prompt('PoolLab pH-Wert eingeben','');if(value===null)return;value=Number(String(value).replace(',','.'));if(!Number.isFinite(value)||value<0||value>14){w.alert('Bitte einen gültigen PoolLab-pH-Wert eingeben.');return}if(typeof window.poolSetState!=='function'){w.alert('VIS setState ist nicht verfügbar.');return}Promise.resolve(window.poolSetState('${inputId}',value)).then(function(ok){if(ok===false)throw new Error();return window.poolSetState('${triggerId}',Date.now())}).then(function(ok){if(ok===false)throw new Error()}).catch(function(){w.alert('PoolLab-Wert konnte nicht gespeichert werden.')})}function run(ev){var card=phCard(ev.target);if(!card)return;var now=Date.now();if(now-last<650)return;last=now;try{ev.preventDefault();ev.stopPropagation()}catch(e){}dialog()}document.addEventListener('click',run,true);try{document.addEventListener('touchend',run,{capture:true,passive:false})}catch(e){document.addEventListener('touchend',run,true)}})();`;
}

function patchOutput(html, namespace) {
  let result = patchVersion(html);
  if (!result || result.includes('window.__phCalCard19')) return result;
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
  if (!adapter || adapter.__phCalibrationCardInstalled) return adapter;
  adapter.__phCalibrationCardInstalled = true;

  for (const methodName of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = data => patchOutput(
      original({ ...(data || {}), adapterVersion: VERSION }),
      (data && data.namespace) || adapter.namespace
    );
  }

  for (const methodName of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  try { adapter.log.info('[PH-KAL] v0.4.19: PoolLab-Eingabe auf kompletter pH-Kachel aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

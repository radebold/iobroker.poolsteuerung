'use strict';

const createBase = require('./main-phcalibration.js');
const VERSION = 'v0.4.20';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19)/g, VERSION);
}

function addCompactPhInput(html, namespace) {
  let result = patchVersion(html);
  if (!result || result.includes('window.__pc20')) return result;
  const code = `(function(){if(window.__pc20)return;window.__pc20=1;var n=${JSON.stringify(namespace)},t=0,f=function(e){var z=Date.now();if(z-t<700)return;t=z;e.preventDefault();e.stopPropagation();var v=prompt('PoolLab pH-Wert','');if(v==null)return;v=Number(String(v).replace(',','.'));if(!(v>=0&&v<=14))return alert('Ungültiger pH-Wert');Promise.resolve(window.poolSetState(n+'.control.ph.calibration.poollabValue',v)).then(function(){return window.poolSetState(n+'.control.ph.calibration.saveTrigger',Date.now())})},a=document.querySelectorAll('.ps-metric,.metric');for(var i=0;i<a.length;i++){var l=a[i].querySelector('.ps-k,.metric-label');if(l&&l.textContent.trim().toLowerCase()=='ph'){a[i].style.cursor='pointer';a[i].addEventListener('click',f);a[i].addEventListener('touchend',f,{passive:false})}}})();`;
  if (result.includes('</script></body>')) return result.replace('</script></body>', `${code}</script></body>`);
  return result;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationCompactInstalled) return adapter;
  adapter.__phCalibrationCompactInstalled = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => addCompactPhInput(
      original({ ...(data || {}), adapterVersion: VERSION }),
      (data && data.namespace) || adapter.namespace
    );
  }

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(h);
      if (adapter.isShuttingDown) return;
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      try { await adapter.forceImmediateRender(); } catch {}
    }, 3000));
  });

  try { adapter.log.info('[PH-KAL] v0.4.20: kompakte PoolLab-Eingabe aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

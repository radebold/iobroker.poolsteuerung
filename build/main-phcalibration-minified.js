'use strict';

const createBase = require('./main-phcalibration.js');
const VERSION = 'v0.4.21';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20)/g, VERSION);
}

function compactOutsideScripts(html) {
  return String(html || '').split(/(<script\b[\s\S]*?<\/script>)/gi).map(part => {
    if (/^<script\b/i.test(part)) return part;
    let value = part.replace(/<!--[\s\S]*?-->/g, '');
    value = value.replace(/<style>([\s\S]*?)<\/style>/gi, (_all, css) => {
      const min = String(css)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{}:;,])\s*/g, '$1')
        .trim();
      return `<style>${min}</style>`;
    });
    return value.replace(/[\r\n\t]+/g, ' ').replace(/>\s+</g, '><').trim();
  }).join('');
}

function eventCode(namespace) {
  const ns = JSON.stringify(namespace);
  return `(function(){if(window.__pc21)return;window.__pc21=1;var n=${ns};function s(i,v){return window.poolSetState(i,v)}function o(){if(document.getElementById('pc21'))return;var d=document.createElement('div');d.id='pc21';d.style='position:fixed;inset:0;z-index:2147483000;background:#000b;display:flex;align-items:center;justify-content:center';d.innerHTML='<div style="width:300px;padding:18px;border-radius:16px;background:#112a45;color:#fff;font:16px Arial"><b>PoolLab pH-Wert</b><input id="pc21i" inputmode="decimal" style="width:100%;margin:14px 0;padding:12px;font-size:28px;box-sizing:border-box" placeholder="7,23"><div style="display:flex;gap:8px"><button id="pc21c" style="flex:1;padding:12px">Abbrechen</button><button id="pc21s" style="flex:1;padding:12px">Speichern</button></div></div>';document.body.appendChild(d);var i=document.getElementById('pc21i'),b=document.getElementById('pc21s');i.focus();document.getElementById('pc21c').onclick=function(){d.remove()};b.onclick=function(){var v=Number(i.value.replace(',','.'));if(!(v>=0&&v<=14)){i.focus();return}b.disabled=true;b.textContent='Speichere';Promise.resolve(s(n+'.control.ph.calibration.poollabValue',v)).then(function(){return s(n+'.control.ph.calibration.saveTrigger',Date.now())}).then(function(){d.remove()}).catch(function(){b.disabled=false;b.textContent='Fehler'})}}document.addEventListener('click',function(e){var c=e.target.closest&&e.target.closest('.ps-metric,.metric');if(!c)return;var l=c.querySelector('.ps-k,.metric-label');if(!l||l.textContent.trim().toLowerCase()!='ph')return;e.preventDefault();e.stopPropagation();o()},true)})();`;
}

function buildOutput(html, namespace) {
  const base = patchVersion(html);
  const compact = compactOutsideScripts(base);
  const code = eventCode(namespace);
  let result = compact;
  if (result.includes('</script></body>')) result = result.replace('</script></body>', `${code}</script></body>`);
  else if (result.includes('</body>')) result = result.replace('</body>', `<script>${code}</script></body>`);
  return { base, compact, result };
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationMinifiedInstalled) return adapter;
  adapter.__phCalibrationMinifiedInstalled = true;
  adapter.__phCalibrationSizeLogged = {};

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const out = buildOutput(
        original({ ...(data || {}), adapterVersion: VERSION }),
        (data && data.namespace) || adapter.namespace
      );
      if (!adapter.__phCalibrationSizeLogged[name]) {
        adapter.__phCalibrationSizeLogged[name] = true;
        adapter.log.info(`[PH-KAL] ${name}: ${out.base.length} -> ${out.compact.length} -> ${out.result.length} Zeichen`);
      }
      if (out.result.length >= out.base.length) {
        adapter.log.warn(`[PH-KAL] ${name}: kompakte Ausgabe nicht kleiner; stabile Ausgabe ohne Eingabe wird verwendet`);
        return out.base;
      }
      return out.result;
    };
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
      adapter.lastTabletHtml = '';
      adapter.lastTabletWidget = '';
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      try { await adapter.forceImmediateRender(); } catch {}
    }, 3000));
  });

  try { adapter.log.info('[PH-KAL] v0.4.21: komprimierte VIS mit PoolLab-Eingabe aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

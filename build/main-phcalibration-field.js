'use strict';

const createBase = require('./main-phcalibration.js');
const VERSION = 'v0.4.25';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24)/g, VERSION);
}

function compactOutsideScripts(html) {
  return String(html || '').split(/(<script\b[\s\S]*?<\/script>)/gi).map(part => {
    if (/^<script\b/i.test(part)) return part;
    return part
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<style>([\s\S]*?)<\/style>/gi, (_all, css) => `<style>${String(css)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{}:;,])\s*/g, '$1')
        .trim()}</style>`)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();
  }).join('');
}

function addPoolLabField(html, namespace) {
  const base = patchVersion(html);
  let result = compactOutsideScripts(base);
  const scriptPos = result.lastIndexOf('<script>');
  const bindNeedle = 'const bind = () => {';
  if (scriptPos < 0 || !result.includes(bindNeedle)) {
    return { html: base, ok: false, baseLength: base.length, finalLength: base.length };
  }

  const row = '<div class="pc25" style="position:fixed;left:6px;right:6px;bottom:6px;z-index:9999;max-width:310px;margin:auto;display:grid;grid-template-columns:auto 76px 1fr;gap:6px;align-items:center;padding:7px 8px;border:1px solid rgba(255,255,255,.14);border-radius:12px;background:linear-gradient(180deg,#173457,#0c2038);box-shadow:0 8px 22px rgba(0,0,0,.35);color:#fff;font:700 12px Arial"><span>PoolLab</span><input class="js-poollab-input" inputmode="decimal" autocomplete="off" placeholder="7,23" style="width:76px;height:34px;border:1px solid #55c8ff;border-radius:8px;background:#061524;color:#fff;padding:4px 7px;font-size:18px;font-weight:900;outline:none"><button type="button" class="js-poollab-save" style="height:34px;border:0;border-radius:8px;background:linear-gradient(135deg,#258bd1,#20b9a6);color:#fff;font-weight:900">Speichern</button></div>';
  result = `${result.slice(0, scriptPos)}${row}${result.slice(scriptPos)}`;

  const ns = JSON.stringify(namespace);
  const handler = `var pi=document.querySelector('.js-poollab-input'),pb=document.querySelector('.js-poollab-save'),pl=0;if(pi&&pb){var ps=async function(e){try{e.preventDefault();e.stopPropagation()}catch(x){}var z=Date.now();if(z-pl<700)return;pl=z;var v=Number(String(pi.value||'').trim().replace(',','.'));if(!(v>=0&&v<=14)){pb.textContent='Ungültig';setTimeout(function(){pb.textContent='Speichern'},1200);pi.focus();return}pb.disabled=true;pb.textContent='Speichere';var n=${ns};var a=await window.poolSetState(n+'.control.ph.calibration.poollabValue',v);var b=a?await window.poolSetState(n+'.control.ph.calibration.saveTrigger',Date.now()):false;pb.textContent=a&&b?'Gespeichert':'Fehler';if(a&&b)pi.value='';setTimeout(function(){pb.disabled=false;pb.textContent='Speichern'},1300)};try{pb.addEventListener('touchend',ps,{passive:false})}catch(x){}pb.addEventListener('click',ps);pi.addEventListener('click',function(e){e.stopPropagation()});pi.addEventListener('touchend',function(e){e.stopPropagation()},{passive:false});pi.addEventListener('keydown',function(e){if(e.key==='Enter')ps(e)})}`;
  result = result.replace(bindNeedle, `${bindNeedle}${handler}`);

  const safe = result.length < base.length && result.length < 32000;
  return { html: safe ? result : base, ok: safe, baseLength: base.length, finalLength: result.length };
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationFieldInstalled) return adapter;
  adapter.__phCalibrationFieldInstalled = true;
  adapter.__phCalibrationFieldLogged = {};

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const out = addPoolLabField(
        original({ ...(data || {}), adapterVersion: VERSION }),
        (data && data.namespace) || adapter.namespace
      );
      if (!adapter.__phCalibrationFieldLogged[name]) {
        adapter.__phCalibrationFieldLogged[name] = true;
        const level = out.ok ? 'info' : 'warn';
        adapter.log[level](`[PH-KAL] ${name}: ${out.baseLength} -> ${out.finalLength} Zeichen | ${out.ok ? 'Eingabefeld aktiv' : 'stabile Ausgabe ohne Eingabefeld'}`);
      }
      return out.html;
    };
  }

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      adapter.lastTabletHtml = '';
      adapter.lastTabletWidget = '';
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      try { await adapter.forceImmediateRender(); } catch {}
    }, 3000));
  });

  try { adapter.log.info('[PH-KAL] v0.4.25: sichtbares PoolLab-Eingabefeld aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

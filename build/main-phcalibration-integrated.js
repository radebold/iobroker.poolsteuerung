'use strict';

const createBase = require('./main-phcalibration.js');
const VERSION = 'v0.4.24';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23)/g, VERSION);
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

function replaceAfter(html, labelHtml, needle, replacement) {
  const labelPos = html.indexOf(labelHtml);
  if (labelPos < 0) return html;
  const valuePos = html.indexOf(needle, labelPos + labelHtml.length);
  if (valuePos < 0) return html;
  return `${html.slice(0, valuePos)}${replacement}${html.slice(valuePos + needle.length)}`;
}

function addPoolLabControl(html, namespace, widget) {
  const base = patchVersion(html);
  let result = compactOutsideScripts(base);

  result = widget
    ? replaceAfter(result, '<div class="ps-k">pH</div>', '<div class="ps-v">', '<div class="ps-v js-phcal">')
    : replaceAfter(result, '<div class="metric-label">pH</div>', '<div class="metric-value">', '<div class="metric-value js-phcal">');

  const bindNeedle = 'const bind = () => {';
  const ns = JSON.stringify(namespace);
  const handler = `bindOne('.js-phcal',async()=>{let v=prompt('PoolLab pH-Wert eingeben','');if(v===null)return;v=Number(String(v).replace(',','.'));if(!(v>=0&&v<=14)){alert('Bitte einen gültigen pH-Wert eingeben');return}const n=${ns};await window.poolSetState(n+'.control.ph.calibration.poollabValue',v);const ok=await window.poolSetState(n+'.control.ph.calibration.saveTrigger',Date.now());if(!ok)alert('PoolLab-Wert konnte nicht gespeichert werden')});`;

  if (!result.includes('js-phcal') || !result.includes(bindNeedle)) {
    return { html: base, ok: false, baseLength: base.length, finalLength: base.length };
  }

  result = result.replace(bindNeedle, `${bindNeedle}${handler}`);
  const safe = result.length < base.length && result.length < 32000;
  return {
    html: safe ? result : base,
    ok: safe,
    baseLength: base.length,
    finalLength: result.length
  };
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationIntegratedInstalled) return adapter;
  adapter.__phCalibrationIntegratedInstalled = true;
  adapter.__phCalibrationIntegratedLogged = {};

  for (const [name, widget] of [['buildTabletHtml', false], ['buildTabletWidget', true]]) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const out = addPoolLabControl(
        original({ ...(data || {}), adapterVersion: VERSION }),
        (data && data.namespace) || adapter.namespace,
        widget
      );
      if (!adapter.__phCalibrationIntegratedLogged[name]) {
        adapter.__phCalibrationIntegratedLogged[name] = true;
        const level = out.ok ? 'info' : 'warn';
        adapter.log[level](`[PH-KAL] ${name}: ${out.baseLength} -> ${out.finalLength} Zeichen | ${out.ok ? 'PoolLab aktiv' : 'stabile Ausgabe ohne Eingabe'}`);
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

  try { adapter.log.info('[PH-KAL] v0.4.24: PoolLab-Erfassung in vorhandenen VIS-Buttoncode integriert'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

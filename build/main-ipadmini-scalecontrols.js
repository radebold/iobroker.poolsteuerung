'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.32';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';
const TARE_STATE = 'mqtt.0.pool.phminus.waage.cmd.tare';
const RESTART_STATE = 'mqtt.0.pool.phminus.waage.cmd.restart';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.\d+/g, VERSION);
}

function buildControls() {
  return `<div class="scale-command-buttons" data-scale-controls="1">
    <button type="button" class="scale-command tare" data-scale-id="${TARE_STATE}" data-label="Tara" aria-label="Waage tarieren">Tara</button>
    <button type="button" class="scale-command restart" data-scale-id="${RESTART_STATE}" data-label="Restart" aria-label="Waage neu starten">Restart</button>
  </div>`;
}

function buildScript() {
  return `<script data-ipad-scale-controls="1">(function(){if(window.__poolScaleControlsBound)return;window.__poolScaleControlsBound=1;function w(ms){return new Promise(function(r){setTimeout(r,ms)})}function c(){var a=[window];try{if(window.parent&&window.parent!==window)a.push(window.parent)}catch(e){}try{if(window.top&&window.top!==window&&window.top!==window.parent)a.push(window.top)}catch(e){}return a}async function s(id,v){var a=c();for(var i=0;i<a.length;i++){try{var x=a[i].vis;if(x&&typeof x.setValue==='function'){var r=x.setValue(id,v);if(r&&r.then)await r;return true}}catch(e){}try{var q=a[i].vis&&a[i].vis.conn;if(q&&typeof q.setState==='function'){var z=q.setState(id,v);if(z&&z.then)await z;return true}}catch(e){}}return false}async function p(b){if(b.dataset.busy==='1')return;b.dataset.busy='1';var id=b.dataset.scaleId,t=b.dataset.label||b.textContent;b.disabled=true;b.textContent='…';await s(id,false);await w(120);var ok=await s(id,true);await w(650);await s(id,false);b.textContent=ok?'OK':'Fehler';setTimeout(function(){b.textContent=t;b.disabled=false;b.dataset.busy='0'},1100)}document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('.scale-command[data-scale-id]'):null;if(!b)return;e.preventDefault();e.stopPropagation();p(b)},true)})();</script>`;
}

function patchPhCard(html) {
  const labelMarker = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = html.indexOf(labelMarker);
  if (labelIndex < 0) return html;

  const cardStart = html.lastIndexOf('<section class="metric-card"', labelIndex);
  const cardEnd = html.indexOf('</section>', labelIndex);
  if (cardStart < 0 || cardEnd < 0) return html;

  let card = html.slice(cardStart, cardEnd + 10);
  const historyMarker = '<div class="history-wrap">';
  if (!card.includes(historyMarker)) return html;
  card = card.replace(historyMarker, `${buildControls()}${historyMarker}`);
  return html.slice(0, cardStart) + card + html.slice(cardEnd + 10);
}

function patchIpadHtml(html) {
  let value = patchVersion(html);
  if (!value || !value.includes('<span class="metric-label">pH-Wert</span>')) return value;

  value = value
    .replace(/<style data-ipad-scale-controls="1">[\s\S]*?<\/style>/g, '')
    .replace(/<div class="scale-command-buttons"[^>]*data-scale-controls="1">[\s\S]*?<\/div>/g, '')
    .replace(/<script data-ipad-scale-controls="1">[\s\S]*?<\/script>/g, '');

  const css = `<style data-ipad-scale-controls="1">.scale-command-buttons{position:absolute;left:15px;top:126px;z-index:5;display:flex;gap:6px}.scale-command{appearance:none;height:22px;min-width:55px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.14);color:#fff;font-family:inherit;font-size:8px;font-weight:900;letter-spacing:.02em;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,.22)}.scale-command.tare{background:linear-gradient(145deg,#b88219,#77500c);border-color:rgba(255,198,78,.38)}.scale-command.restart{background:linear-gradient(145deg,#c74d48,#7d2927);border-color:rgba(255,112,103,.38)}.scale-command:disabled{opacity:.68;cursor:default}@media(max-width:900px){.scale-command-buttons{left:12px;top:119px;gap:4px}.scale-command{height:20px;min-width:48px;padding:2px 6px;font-size:7px}}</style>`;
  value = value.includes('</head>') ? value.replace('</head>', `${css}</head>`) : css + value;
  value = patchPhCard(value);
  const script = buildScript();
  return value.includes('</body>') ? value.replace('</body>', `${script}</body>`) : value + script;
}

function install(adapter) {
  if (!adapter || adapter.__ipadMiniScaleControlsInstalled) return adapter;
  adapter.__ipadMiniScaleControlsInstalled = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchState() {
    const state = await adapter.getStateAsync(IPAD_MINI_STATE);
    if (!state || typeof state.val !== 'string' || state.val.length < 50) return;
    const html = patchIpadHtml(state.val);
    if (html.length > 32000) {
      adapter.log.warn(`[IPAD-MINI] Waagen-Taster nicht eingefügt: Ausgabe wäre mit ${html.length} Zeichen zu groß`);
      return;
    }
    await adapter.setStateIfChanged(IPAD_MINI_STATE, html, true);
  }

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRenderVisFull(...args);
    try { await patchState(); }
    catch (error) {
      if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Waagen-Taster konnten nicht aktualisiert werden: ' + (error.message || error));
    }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [3000, 8000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try { await patchState(); }
        catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Waagen-Taster konnten beim Start nicht erzeugt werden: ' + (error.message || error));
        }
      }, delay));
    }
  });

  try { adapter.log.info('[IPAD-MINI] v0.4.32: Tara- und Restart-Taster für die pH-Minus-Waage aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

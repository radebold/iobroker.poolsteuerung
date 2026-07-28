'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.34';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';
const MAX_HTML_LENGTH = 31500;

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.\d+/g, VERSION);
}

function compactHtml(html) {
  let value = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  value = value.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attrs, css) => {
    const compactCss = String(css || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,])\s*/g, '$1')
      .trim();
    return `<style${attrs}>${compactCss}</style>`;
  });
  return value.replace(/>\s+</g, '><').trim();
}

function buildDoseControls() {
  return '<div class="ph-manual-controls" data-ph-manual-controls="1"><b>Dosieren</b><button type="button" class="ph-manual-dose" data-sec="60">60 s</button><button type="button" class="ph-manual-dose" data-sec="120">120 s</button><button type="button" class="ph-manual-dose" data-sec="180">180 s</button></div>';
}

function buildDoseScript(namespace) {
  const ns = JSON.stringify(String(namespace || 'poolsteuerung.0'));
  return `<script data-ph-manual-dose="1">(function(){if(window.__poolPhDoseMini)return;window.__poolPhDoseMini=1;function v(){try{if(window.vis)return window.vis}catch(e){}try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}return null}async function s(i,x){var a=v();try{if(a&&typeof a.setValue==='function'){var r=a.setValue(i,x);if(r&&typeof r.then==='function')await r;return true}}catch(e){}try{if(a&&a.conn&&typeof a.conn.setState==='function'){var q=a.conn.setState(i,x);if(q&&typeof q.then==='function')await q;return true}}catch(e){}return false}document.addEventListener('click',async function(e){var b=e.target&&e.target.closest?e.target.closest('.ph-manual-dose[data-sec]'):null;if(!b||b.disabled)return;e.preventDefault();e.stopPropagation();var n=${ns},x=Math.max(1,Number(b.dataset.sec)||30),t=b.textContent;b.disabled=true;b.textContent='…';var a=await s(n+'.control.ph.manualDoseSec',x);var o=a&&await s(n+'.control.ph.manualTrigger',Date.now());b.textContent=o?'OK':'Fehler';setTimeout(function(){b.disabled=false;b.textContent=t},1200)},true)})();</script>`;
}

function patchDoseControls(html, namespace) {
  const original = patchVersion(html);
  if (!original || !original.includes('<span class="metric-label">pH-Wert</span>')) {
    return { html: original, applied: false, originalLength: original.length, compactLength: original.length, finalLength: original.length };
  }

  let clean = original
    .replace(/<style data-ph-manual-dose="1">[\s\S]*?<\/style>/g, '')
    .replace(/<div class="ph-manual-controls"[^>]*data-ph-manual-controls="1">[\s\S]*?<\/div>/g, '')
    .replace(/<script data-ph-manual-dose="1">[\s\S]*?<\/script>/g, '');

  clean = compactHtml(clean);
  const labelIndex = clean.indexOf('<span class="metric-label">pH-Wert</span>');
  const cardStart = clean.lastIndexOf('<section class="metric-card"', labelIndex);
  const cardEnd = clean.indexOf('</section>', labelIndex);
  if (labelIndex < 0 || cardStart < 0 || cardEnd < 0) {
    return { html: original, applied: false, originalLength: original.length, compactLength: clean.length, finalLength: original.length };
  }

  let card = clean.slice(cardStart, cardEnd + 10);
  const historyMarker = '<div class="history-wrap">';
  if (!card.includes(historyMarker)) {
    return { html: original, applied: false, originalLength: original.length, compactLength: clean.length, finalLength: original.length };
  }

  card = card.replace(historyMarker, `${buildDoseControls()}${historyMarker}`);
  let candidate = clean.slice(0, cardStart) + card + clean.slice(cardEnd + 10);
  const css = '<style data-ph-manual-dose="1">.ph-manual-controls{position:absolute;left:15px;top:126px;z-index:6;display:flex;align-items:center;gap:5px}.ph-manual-controls b{font-size:8px;color:#aebed0;text-transform:uppercase;letter-spacing:.04em}.ph-manual-dose{appearance:none;height:22px;min-width:45px;padding:2px 7px;border:1px solid rgba(105,196,255,.32);border-radius:999px;background:linear-gradient(145deg,#247dc0,#174a79);color:#fff;font:900 8px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,.22)}.ph-manual-dose:disabled{opacity:.65}@media(max-width:900px){.ph-manual-controls{left:12px;top:119px;gap:4px}.ph-manual-controls b{display:none}.ph-manual-dose{height:20px;min-width:39px;padding:2px 5px;font-size:7px}}</style>';
  candidate = candidate.includes('</head>') ? candidate.replace('</head>', `${css}</head>`) : css + candidate;
  const script = buildDoseScript(namespace);
  candidate = candidate.includes('</body>') ? candidate.replace('</body>', `${script}</body>`) : candidate + script;

  const safe = candidate.length < original.length && candidate.length <= MAX_HTML_LENGTH;
  return {
    html: safe ? candidate : original,
    applied: safe,
    originalLength: original.length,
    compactLength: clean.length,
    finalLength: safe ? candidate.length : original.length
  };
}

function install(adapter) {
  if (!adapter || adapter.__ipadMiniManualDoseInstalled) return adapter;
  adapter.__ipadMiniManualDoseInstalled = true;
  adapter.__ipadMiniManualDoseLogged = false;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchIpadState() {
    const state = await adapter.getStateAsync(IPAD_MINI_STATE);
    if (!state || typeof state.val !== 'string' || state.val.length < 50) return false;
    const result = patchDoseControls(state.val, adapter.namespace);
    await adapter.setStateIfChanged(IPAD_MINI_STATE, result.html, true);
    if (!adapter.__ipadMiniManualDoseLogged) {
      adapter.__ipadMiniManualDoseLogged = true;
      const level = result.applied ? 'info' : 'warn';
      adapter.log[level](`[IPAD-MINI] pH-Dosierbuttons ${result.applied ? 'aktiv' : 'nicht eingefügt'}: ${result.originalLength} -> ${result.compactLength} -> ${result.finalLength} Zeichen`);
    }
    return result.applied;
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRenderVisFull = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRenderVisFull(...args);
      try { await patchIpadState(); }
      catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] pH-Dosierbuttons konnten nicht aktualisiert werden: ' + (error.message || error));
      }
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.setStateAsync(IPAD_MINI_STATE, '', true);
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        await adapter.forceImmediateRender();
        await patchIpadState();
        adapter.log.info('[IPAD-MINI] v0.4.34: vollständige Ansicht mit manueller pH-Dosierung erzeugt');
      } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Wiederherstellung mit Dosierbuttons fehlgeschlagen: ' + (error.message || error));
      }
    }, 900));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

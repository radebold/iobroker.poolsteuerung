'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.36';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.\d+/g, VERSION);
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function compactHtml(html) {
  let value = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\saria-(?:hidden|label)="[^"]*"/g, '')
    .replace(/\sdata-(?:heatpump-strip|ph-canister|device-status|circulation-status)="[^"]*"/g, '');

  value = value.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attrs, css) => {
    const compactCss = String(css || '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,])\s*/g, '$1')
      .trim();
    return `<style${attrs}>${compactCss}</style>`;
  });

  return value.replace(/>\s+</g, '><').replace(/\n+/g, '').trim();
}

function simplifyHistoryPaths(html, maxPoints) {
  return String(html || '').replace(/<path d="([^"]+)"([^>]*)>/g, (match, pathData, attrs) => {
    const points = [];
    const pattern = /([ML])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
    let found;
    while ((found = pattern.exec(pathData)) !== null) {
      points.push({ x: found[2], y: found[3] });
    }
    if (points.length <= maxPoints || points.length < 8) return match;

    const selected = [];
    for (let index = 0; index < maxPoints; index++) {
      const sourceIndex = Math.round(index * (points.length - 1) / (maxPoints - 1));
      const point = points[sourceIndex];
      const previous = selected[selected.length - 1];
      if (!previous || previous.x !== point.x || previous.y !== point.y) selected.push(point);
    }
    const compactPath = selected.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
    return `<path d="${compactPath}"${attrs}>`;
  });
}

function buildDoseControls() {
  return '<div class="ph-manual-controls" data-ph-manual-controls="1"><b>pH dosieren</b><button type="button" class="ph-manual-dose" data-sec="60">60 s</button><button type="button" class="ph-manual-dose" data-sec="120">120 s</button><button type="button" class="ph-manual-dose" data-sec="180">180 s</button></div>';
}

function buildDoseScript(namespace) {
  const ns = JSON.stringify(String(namespace || 'poolsteuerung.0'));
  return `<script data-ph-manual-dose="1">(function(){if(window.__poolPhDoseMini)return;window.__poolPhDoseMini=1;function v(){try{if(window.vis)return window.vis}catch(e){}try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}return null}async function s(i,x){var a=v();try{if(a&&typeof a.setValue==='function'){var r=a.setValue(i,x);if(r&&typeof r.then==='function')await r;return true}}catch(e){}try{if(a&&a.conn&&typeof a.conn.setState==='function'){var q=a.conn.setState(i,x);if(q&&typeof q.then==='function')await q;return true}}catch(e){}return false}async function d(b){if(b.disabled)return;var n=${ns},x=Math.max(1,Number(b.dataset.sec)||30),t=b.textContent;b.disabled=true;b.textContent='…';var a=await s(n+'.control.ph.manualDoseSec',x),o=a&&await s(n+'.control.ph.manualTrigger',Date.now());b.textContent=o?'OK':'Fehler';setTimeout(function(){b.disabled=false;b.textContent=t},1200)}function h(e){var b=e.target&&e.target.closest?e.target.closest('.ph-manual-dose[data-sec]'):null;if(!b)return;e.preventDefault();e.stopPropagation();d(b)}document.addEventListener('click',h,true)})();</script>`;
}

function buildCandidate(original, namespace, maxPoints) {
  let clean = String(original || '')
    .replace(/<style data-ph-manual-dose="1">[\s\S]*?<\/style>/g, '')
    .replace(/<div class="ph-manual-controls"[^>]*data-ph-manual-controls="1">[\s\S]*?<\/div>/g, '')
    .replace(/<script data-ph-manual-dose="1">[\s\S]*?<\/script>/g, '');

  clean = compactHtml(simplifyHistoryPaths(clean, maxPoints));
  const labelMatch = /<span class="metric-label">\s*pH-Wert\s*<\/span>/i.exec(clean);
  if (!labelMatch) return { html: original, applied: false, reason: 'pH-Marker fehlt', finalBytes: byteLength(original) };

  const labelIndex = labelMatch.index;
  const cardStart = clean.lastIndexOf('<section class="metric-card"', labelIndex);
  const cardEnd = clean.indexOf('</section>', labelIndex);
  if (cardStart < 0 || cardEnd < 0) return { html: original, applied: false, reason: 'pH-Karte fehlt', finalBytes: byteLength(original) };

  let card = clean.slice(cardStart, cardEnd + 10);
  const historyMarker = '<div class="history-wrap">';
  if (!card.includes(historyMarker)) return { html: original, applied: false, reason: 'Diagramm-Marker fehlt', finalBytes: byteLength(original) };

  card = card.replace(historyMarker, `${buildDoseControls()}${historyMarker}`);
  let candidate = clean.slice(0, cardStart) + card + clean.slice(cardEnd + 10);
  const css = '<style data-ph-manual-dose="1">.ph-manual-controls{position:absolute;left:15px;top:126px;z-index:8;display:flex;align-items:center;gap:5px}.ph-manual-controls b{font-size:8px;color:#b9c9dc;text-transform:uppercase;letter-spacing:.04em}.ph-manual-dose{appearance:none;height:23px;min-width:48px;padding:2px 8px;border:1px solid rgba(105,196,255,.40);border-radius:999px;background:linear-gradient(145deg,#298bd0,#174c7e);color:#fff;font:900 8px Arial,sans-serif;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,.28)}.ph-manual-dose:active{transform:translateY(1px)}.ph-manual-dose:disabled{opacity:.65}@media(max-width:900px){.ph-manual-controls{left:12px;top:119px;gap:4px}.ph-manual-controls b{display:none}.ph-manual-dose{height:21px;min-width:42px;padding:2px 6px;font-size:7px}}</style>';
  candidate = candidate.includes('</head>') ? candidate.replace('</head>', `${css}</head>`) : css + candidate;
  const script = buildDoseScript(namespace);
  candidate = candidate.includes('</body>') ? candidate.replace('</body>', `${script}</body>`) : candidate + script;
  candidate = compactHtml(candidate);
  return { html: candidate, applied: true, reason: `SVG max. ${maxPoints} Punkte`, finalBytes: byteLength(candidate) };
}

function patchDoseControls(html, namespace) {
  const original = patchVersion(html);
  const originalBytes = byteLength(original);
  if (!original || !/pH-Wert/i.test(original)) {
    return { html: original, applied: false, reason: 'pH-Wert fehlt', originalBytes, finalBytes: originalBytes };
  }

  for (const maxPoints of [48, 36, 28, 20, 14]) {
    const result = buildCandidate(original, namespace, maxPoints);
    if (result.applied && result.finalBytes <= originalBytes) {
      return { ...result, originalBytes };
    }
  }

  return { html: original, applied: false, reason: 'Ausgabe würde größer als die stabile Ansicht', originalBytes, finalBytes: originalBytes };
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

  async function patchIpadState(logResult = false) {
    const state = await adapter.getStateAsync(IPAD_MINI_STATE);
    if (!state || typeof state.val !== 'string' || state.val.length < 50) return false;
    const result = patchDoseControls(state.val, adapter.namespace);
    await adapter.setStateIfChanged(IPAD_MINI_STATE, result.html, true);
    if (logResult || !adapter.__ipadMiniManualDoseLogged) {
      adapter.__ipadMiniManualDoseLogged = true;
      const level = result.applied ? 'info' : 'warn';
      adapter.log[level](`[IPAD-MINI] pH-Dosierbuttons ${result.applied ? 'aktiv' : 'nicht eingefügt'}: ${result.originalBytes} -> ${result.finalBytes} Bytes | ${result.reason}`);
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
    for (const delay of [900, 2800, 7000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          if (delay === 900) {
            await adapter.setStateAsync(IPAD_MINI_STATE, '', true);
            adapter.lastRenderSignature = '';
            adapter.lastRenderAt = 0;
            await adapter.forceImmediateRender();
          }
          const active = await patchIpadState(delay === 2800);
          if (delay === 2800 && active) adapter.log.info('[IPAD-MINI] v0.4.36: 60/120/180-Sekunden-Dosierbuttons sichtbar erzeugt');
        } catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Wiederherstellung mit Dosierbuttons fehlgeschlagen: ' + (error.message || error));
        }
      }, delay));
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

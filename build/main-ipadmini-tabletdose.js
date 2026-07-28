'use strict';

const createBase = require('./main-ipadmini-stable.js');

const VERSION = 'v0.4.41';
const STATE_ID = 'vis.htmlIpadMini';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.\d+/g, VERSION);
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function compactHtml(html) {
  let value = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  value = value.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attrs, css) => {
    const min = String(css || '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>+~])\s*/g, '$1')
      .trim();
    return `<style${attrs}>${min}</style>`;
  });
  return value.replace(/>\s+</g, '><').replace(/[\r\n\t]+/g, '').trim();
}

function controlsHtml() {
  return '<div class="ipad-manual-presets" data-ipad-tablet-dose="1"><button type="button" class="manual-btn js-ipad-manual-dose" data-sec="60" onclick="window.poolPhManualDose(60);return false"><span>60 Sek.</span><small>Start Dosierung</small></button><button type="button" class="manual-btn js-ipad-manual-dose" data-sec="120" onclick="window.poolPhManualDose(120);return false"><span>120 Sek.</span><small>Start Dosierung</small></button><button type="button" class="manual-btn js-ipad-manual-dose" data-sec="180" onclick="window.poolPhManualDose(180);return false"><span>180 Sek.</span><small>Start Dosierung</small></button></div>';
}

function controlsCss() {
  return '<style data-ipad-tablet-dose="1">.ipad-manual-presets{position:absolute;left:15px;top:121px;z-index:6;display:grid;grid-template-columns:repeat(3,58px);gap:5px}.ipad-manual-presets .manual-btn{appearance:none;border:1px solid rgba(255,255,255,.09);cursor:pointer;text-align:center;height:29px;padding:3px 5px;border-radius:10px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 5px 12px rgba(6,24,44,.28);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}.ipad-manual-presets .manual-btn span{font-size:9px;line-height:10px}.ipad-manual-presets .manual-btn small{font-size:6px;line-height:7px;color:#dbeafe}.ipad-manual-presets .manual-btn:active{transform:translateY(1px)}@media(max-width:900px){.ipad-manual-presets{left:12px;top:114px;grid-template-columns:repeat(3,52px);gap:4px}.ipad-manual-presets .manual-btn{height:26px;padding:2px 4px}.ipad-manual-presets .manual-btn span{font-size:8px}.ipad-manual-presets .manual-btn small{font-size:5px}}</style>';
}

function controlsScript(namespace) {
  const ns = JSON.stringify(String(namespace || 'poolsteuerung.0'));
  return `<script data-ipad-tablet-dose="1">(function(){function v(){try{if(window.vis)return window.vis}catch(e){}try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}return null}function c(){try{var x=v();if(x&&x.conn&&typeof x.conn.setState==='function')return x.conn}catch(e){}return null}window.poolSetState=async function(i,x){var a=v(),o=c();try{if(a&&typeof a.setValue==='function'){var r=a.setValue(i,x);if(r&&typeof r.then==='function')await r;return true}}catch(e){}if(!o)return false;for(var f of [function(){return o.setState(i,x)},function(){return o.setState(i,x,false)},function(){return o.setState(i,x,function(){})}])try{var q=f();if(q&&typeof q.then==='function')await q;return true}catch(e){}return false};window.poolPhManualDose=async function(s){var n=${ns};await window.poolSetState(n+'.control.ph.manualDoseSec',Number(s)||30);var ok=await window.poolSetState(n+'.control.ph.manualTrigger',Date.now());if(!ok)alert('VIS setState nicht verfügbar')}})();</script>`;
}

function patchDoseButtons(html, namespace) {
  const original = patchVersion(html)
    .replace(/<style data-ipad-tablet-dose="1">[\s\S]*?<\/style>/g, '')
    .replace(/<div class="ipad-manual-presets"[^>]*data-ipad-tablet-dose="1">[\s\S]*?<\/div>/g, '')
    .replace(/<script data-ipad-tablet-dose="1">[\s\S]*?<\/script>/g, '');
  if (!original.includes('</html>')) return { html: original, applied: false, reason: 'unvollständige Basis', before: byteLength(original), after: byteLength(original) };

  const label = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = original.indexOf(label);
  if (labelIndex < 0) return { html: original, applied: false, reason: 'pH-Kachel nicht gefunden', before: byteLength(original), after: byteLength(original) };
  const cardStart = original.lastIndexOf('<section class="metric-card"', labelIndex);
  const cardEnd = original.indexOf('</section>', labelIndex);
  if (cardStart < 0 || cardEnd < 0) return { html: original, applied: false, reason: 'pH-Kartenrahmen nicht gefunden', before: byteLength(original), after: byteLength(original) };

  let card = original.slice(cardStart, cardEnd + 10);
  const historyMarker = '<div class="history-wrap">';
  if (!card.includes(historyMarker)) return { html: original, applied: false, reason: 'Verlaufsmarker nicht gefunden', before: byteLength(original), after: byteLength(original) };
  card = card.replace(historyMarker, controlsHtml() + historyMarker);

  let candidate = original.slice(0, cardStart) + card + original.slice(cardEnd + 10);
  candidate = candidate.replace('</head>', controlsCss() + '</head>');
  candidate = candidate.replace('</body>', controlsScript(namespace) + '</body>');
  candidate = compactHtml(candidate);

  const before = byteLength(original);
  const after = byteLength(candidate);
  if (!candidate.includes('</html>') || !candidate.includes('data-sec="60"') || !candidate.includes('poolPhManualDose')) {
    return { html: original, applied: false, reason: 'Endprüfung fehlgeschlagen', before, after };
  }
  if (after > before) {
    return { html: original, applied: false, reason: `kompakte Ausgabe wäre ${after - before} Bytes größer`, before, after };
  }
  return { html: candidate, applied: true, reason: 'Tablet-Dosierblock übernommen', before, after };
}

function install(adapter) {
  if (!adapter || adapter.__ipadMiniTabletDoseInstalled) return adapter;
  adapter.__ipadMiniTabletDoseInstalled = true;
  adapter.__ipadMiniTabletDoseLogged = false;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function apply(logResult = false) {
    const state = await adapter.getStateAsync(STATE_ID);
    const current = state && typeof state.val === 'string' ? state.val : '';
    if (current.length < 1000 || !current.includes('</html>')) return false;
    const result = patchDoseButtons(current, adapter.namespace);
    if (result.applied) await adapter.setStateIfChanged(STATE_ID, result.html, true);
    if (logResult || !adapter.__ipadMiniTabletDoseLogged) {
      adapter.__ipadMiniTabletDoseLogged = true;
      const level = result.applied ? 'info' : 'warn';
      adapter.log[level](`[IPAD-MINI] Tablet-pH-Dosierung ${result.applied ? 'aktiv' : 'nicht eingefügt'}: ${result.before} -> ${result.after} Bytes | ${result.reason}`);
    }
    return result.applied;
  }

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    try { await apply(false); }
    catch (error) {
      if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Tablet-Dosierblock konnte nicht übernommen werden: ' + (error.message || error));
    }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [1800, 4600, 8200]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          if (delay === 1800) {
            adapter.lastRenderSignature = '';
            adapter.lastRenderAt = 0;
            await adapter.forceImmediateRender();
          }
          await apply(delay === 4600);
        } catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Tablet-Dosierblock nach Start fehlgeschlagen: ' + (error.message || error));
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

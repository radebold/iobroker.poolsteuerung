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

function compactHistoryPaths(html, maxPoints) {
  const number = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
  const commandRegex = new RegExp(`[ML]\\s*${number}\\s+${number}`, 'g');
  return String(html || '').replace(
    /(<svg class="history-svg"[\s\S]*?<path d=")([^"]+)(" fill="none" stroke="[^"]+"[^>]*>)/g,
    (all, prefix, path, suffix) => {
      const commands = String(path || '').match(commandRegex) || [];
      if (commands.length <= maxPoints || maxPoints < 2) return all;
      const reduced = [];
      for (let index = 0; index < maxPoints; index++) {
        const sourceIndex = Math.round(index * (commands.length - 1) / (maxPoints - 1));
        const coords = commands[sourceIndex].replace(/^[ML]\s*/, '').trim();
        reduced.push(`${index === 0 ? 'M' : 'L'} ${coords}`);
      }
      return prefix + reduced.join(' ') + suffix;
    }
  );
}

function controlsHtml() {
  return '<div class="ipad-manual-presets" data-ipad-tablet-dose="1"><button type="button" class="manual-btn js-ipad-manual-dose" data-sec="60"><span>60 Sek.</span><small>Start Dosierung</small></button><button type="button" class="manual-btn js-ipad-manual-dose" data-sec="120"><span>120 Sek.</span><small>Start Dosierung</small></button><button type="button" class="manual-btn js-ipad-manual-dose" data-sec="180"><span>180 Sek.</span><small>Start Dosierung</small></button></div>';
}

function controlsCss() {
  return '<style data-ipad-tablet-dose="1">.ipad-manual-presets{position:absolute;left:15px;top:121px;z-index:7;display:grid;grid-template-columns:repeat(3,58px);gap:5px}.ipad-manual-presets .manual-btn{appearance:none;border:1px solid rgba(255,255,255,.09);cursor:pointer;text-align:center;height:29px;padding:3px 5px;border-radius:10px;background:linear-gradient(180deg,#2d4f86,#162d52);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 5px 12px rgba(6,24,44,.28);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}.ipad-manual-presets .manual-btn span{font-size:9px;line-height:10px}.ipad-manual-presets .manual-btn small{font-size:6px;line-height:7px;color:#dbeafe}.ipad-manual-presets .manual-btn:active{transform:translateY(1px)}.ipad-manual-presets .manual-btn:disabled{opacity:.65}@media(max-width:900px){.ipad-manual-presets{left:12px;top:114px;grid-template-columns:repeat(3,52px);gap:4px}.ipad-manual-presets .manual-btn{height:26px;padding:2px 4px}.ipad-manual-presets .manual-btn span{font-size:8px}.ipad-manual-presets .manual-btn small{font-size:5px}}</style>';
}

function controlsScript(namespace) {
  const ns = JSON.stringify(String(namespace || 'poolsteuerung.0'));
  return `<script data-ipad-tablet-dose="1">(function(){function v(){try{if(window.vis)return window.vis}catch(e){}try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}return null}function c(){try{var x=v();if(x&&x.conn&&typeof x.conn.setState==='function')return x.conn}catch(e){}return null}async function s(i,x){var a=v(),o=c();try{if(a&&typeof a.setValue==='function'){var r=a.setValue(i,x);if(r&&typeof r.then==='function')await r;return true}}catch(e){}if(!o)return false;var f=[function(){return o.setState(i,x)},function(){return o.setState(i,x,false)},function(){return o.setState(i,x,function(){})}];for(var j=0;j<f.length;j++)try{var q=f[j]();if(q&&typeof q.then==='function')await q;return true}catch(e){}return false}async function d(b){if(b.disabled)return;var old=b.innerHTML,sec=Number(b.dataset.sec)||60;b.disabled=true;b.innerHTML='<span>…</span><small>Start Dosierung</small>';var n=${ns};var ok=await s(n+'.control.ph.manualDoseSec',sec);if(ok)ok=await s(n+'.control.ph.manualTrigger',Date.now());b.innerHTML=ok?'<span>OK</span><small>Dosierung gestartet</small>':'<span>Fehler</span><small>nicht gestartet</small>';setTimeout(function(){b.innerHTML=old;b.disabled=false},1400)}document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('.js-ipad-manual-dose'):null;if(!b)return;e.preventDefault();e.stopPropagation();d(b)},true)})();</script>`;
}

function stripPrevious(html) {
  return patchVersion(html)
    .replace(/<style data-ipad-tablet-dose="1">[\s\S]*?<\/style>/g, '')
    .replace(/<div class="ipad-manual-presets"[^>]*data-ipad-tablet-dose="1">[\s\S]*?<\/div>/g, '')
    .replace(/<script data-ipad-tablet-dose="1">[\s\S]*?<\/script>/g, '');
}

function buildCandidate(html, namespace, maxPoints) {
  const original = stripPrevious(html);
  const label = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = original.indexOf(label);
  if (labelIndex < 0) return { html: original, applied: false, reason: 'pH-Kachel nicht gefunden', points: 0 };
  const cardStart = original.lastIndexOf('<section class="metric-card"', labelIndex);
  const cardEnd = original.indexOf('</section>', labelIndex);
  if (cardStart < 0 || cardEnd < 0) return { html: original, applied: false, reason: 'pH-Kartenrahmen nicht gefunden', points: 0 };

  let card = original.slice(cardStart, cardEnd + 10);
  const historyMarker = '<div class="history-wrap">';
  if (!card.includes(historyMarker)) return { html: original, applied: false, reason: 'Verlaufsmarker nicht gefunden', points: 0 };
  card = card.replace(historyMarker, controlsHtml() + historyMarker);

  let candidate = original.slice(0, cardStart) + card + original.slice(cardEnd + 10);
  candidate = candidate.replace('</head>', controlsCss() + '</head>');
  candidate = candidate.replace('</body>', controlsScript(namespace) + '</body>');
  candidate = compactHistoryPaths(candidate, maxPoints);
  candidate = compactHtml(candidate);

  const valid = candidate.includes('</html>')
    && candidate.includes('data-sec="60"')
    && candidate.includes('data-sec="120"')
    && candidate.includes('data-sec="180"')
    && candidate.includes('manualDoseSec')
    && candidate.includes(VERSION);
  return {
    html: valid ? candidate : original,
    applied: valid,
    reason: valid ? 'Tablet-Dosierblock direkt übernommen' : 'Endprüfung fehlgeschlagen',
    points: maxPoints
  };
}

function patchDoseButtons(html, namespace) {
  const original = stripPrevious(html);
  const before = byteLength(original);
  const pointOptions = [120, 96, 72, 56, 40, 32, 24, 16, 12];
  let last = { html: original, applied: false, reason: 'kein passender Größenstand', points: 0 };

  for (const points of pointOptions) {
    const result = buildCandidate(original, namespace, points);
    last = result;
    if (!result.applied) break;
    const after = byteLength(result.html);
    if (after <= before - 32) {
      return { ...result, before, after };
    }
  }

  return { ...last, html: original, applied: false, before, after: byteLength(last.html) };
}

function validStoredHtml(html) {
  const value = String(html || '');
  return value.includes('</html>')
    && value.includes('data-sec="60"')
    && value.includes('data-sec="120"')
    && value.includes('data-sec="180"')
    && value.includes(VERSION);
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

    const stable = patchVersion(stripPrevious(current));
    const result = patchDoseButtons(stable, adapter.namespace);
    const target = result.applied ? result.html : stable;
    await adapter.setStateIfChanged(STATE_ID, target, true);

    const storedState = await adapter.getStateAsync(STATE_ID);
    const stored = String((storedState && storedState.val) || '');
    if (result.applied && !validStoredHtml(stored)) {
      await adapter.setStateAsync(STATE_ID, stable, true);
      result.applied = false;
      result.reason = 'Rückleseprüfung fehlgeschlagen; stabile Ansicht wiederhergestellt';
    }

    if (logResult || !adapter.__ipadMiniTabletDoseLogged) {
      adapter.__ipadMiniTabletDoseLogged = true;
      const level = result.applied ? 'info' : 'warn';
      adapter.log[level](`[IPAD-MINI] ${VERSION} | Tablet-pH-Dosierung ${result.applied ? 'aktiv' : 'nicht eingefügt'}: ${result.before} -> ${result.after} Bytes | ${result.points || 0} Kurvenpunkte | ${result.reason}`);
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

  adapter.log.info(`[IPAD-MINI] ${VERSION}: Versionsanzeige und manuelle pH-Dosierung werden vereinheitlicht`);
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

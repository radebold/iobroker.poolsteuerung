'use strict';

const createBase = require('./main-ipadmini-stable.js');

const VERSION = 'v0.4.42';
const STATE_ID = 'vis.htmlIpadMini';

const bytes = value => Buffer.byteLength(String(value || ''), 'utf8');
const version = html => String(html || '').replace(/v0\.4\.\d+/g, VERSION);

function compact(html) {
  return String(html || '')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<style([^>]*)>([^]*?)<\/style>/gi, (_all, attrs, css) => `<style${attrs}>${String(css)
      .replace(/\/\*[^]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>+~])\s*/g, '$1')
      .trim()}</style>`)
    .replace(/>\s+</g, '><')
    .replace(/[\r\n\t]+/g, '')
    .trim();
}

function reduceHistory(html, maxPoints) {
  const number = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
  const command = new RegExp(`[ML]\\s*${number}\\s+${number}`, 'g');
  return String(html || '').replace(
    /(<svg class="history-svg"[^]*?<path d=")([^"]+)(" fill="none" stroke="[^"]+"[^>]*>)/g,
    (all, before, path, after) => {
      const points = String(path || '').match(command) || [];
      if (points.length <= maxPoints) return all;
      const selected = [];
      for (let i = 0; i < maxPoints; i++) {
        const source = Math.round(i * (points.length - 1) / (maxPoints - 1));
        selected.push(`${i ? 'L' : 'M'} ${points[source].replace(/^[ML]\s*/, '').trim()}`);
      }
      return before + selected.join(' ') + after;
    }
  );
}

function controls() {
  return '<div class="ipad-dose42" data-ipad-dose42="1"><button type="button" data-dose42="60"><b>60 Sek.</b><small>Start Dosierung</small></button><button type="button" data-dose42="120"><b>120 Sek.</b><small>Start Dosierung</small></button><button type="button" data-dose42="180"><b>180 Sek.</b><small>Start Dosierung</small></button></div>';
}

function css() {
  return '<style data-ipad-dose42="1">.ipad-dose42{position:absolute;left:15px;top:121px;z-index:8;display:grid;grid-template-columns:repeat(3,58px);gap:5px}.ipad-dose42 button{height:29px;padding:2px 4px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:linear-gradient(180deg,#2d4f86,#162d52);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 5px 12px rgba(6,24,44,.28);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer}.ipad-dose42 b{font-size:9px;line-height:10px}.ipad-dose42 small{font-size:6px;line-height:7px;color:#dbeafe}.ipad-dose42 button:active{transform:translateY(1px)}.ipad-dose42 button:disabled{opacity:.6}@media(max-width:900px){.ipad-dose42{left:12px;top:114px;grid-template-columns:repeat(3,52px);gap:4px}.ipad-dose42 button{height:26px}.ipad-dose42 b{font-size:8px}.ipad-dose42 small{font-size:5px}}</style>';
}

function script(namespace) {
  const ns = JSON.stringify(String(namespace || 'poolsteuerung.0'));
  return `<script data-ipad-dose42="1">(function(){function a(){try{if(window.vis)return window.vis}catch(e){}try{if(parent&&parent.vis)return parent.vis}catch(e){}try{if(top&&top.vis)return top.vis}catch(e){}return null}async function s(i,v){var x=a();try{if(x&&typeof x.setValue==='function'){var r=x.setValue(i,v);if(r&&r.then)await r;return true}}catch(e){}try{if(x&&x.conn&&typeof x.conn.setState==='function'){var q=x.conn.setState(i,v);if(q&&q.then)await q;return true}}catch(e){}return false}document.addEventListener('click',async function(e){var b=e.target&&e.target.closest?e.target.closest('[data-dose42]'):null;if(!b||b.disabled)return;e.preventDefault();e.stopPropagation();var old=b.innerHTML,n=${ns},sec=Number(b.dataset.dose42);b.disabled=true;b.innerHTML='<b>…</b><small>Start Dosierung</small>';var ok=await s(n+'.control.ph.manualDoseSec',sec);if(ok)ok=await s(n+'.control.ph.manualTrigger',Date.now());b.innerHTML=ok?'<b>OK</b><small>Dosierung gestartet</small>':'<b>Fehler</b><small>nicht gestartet</small>';setTimeout(function(){b.innerHTML=old;b.disabled=false},1400)},true)})();</script>`;
}

function strip(html) {
  return version(html)
    .replace(/<style data-ipad-dose42="1">[^]*?<\/style>/g, '')
    .replace(/<div class="ipad-dose42"[^>]*data-ipad-dose42="1">[^]*?<\/div>/g, '')
    .replace(/<script data-ipad-dose42="1">[^]*?<\/script>/g, '')
    .replace(/<style data-ipad-tablet-dose="1">[^]*?<\/style>/g, '')
    .replace(/<div class="ipad-manual-presets"[^>]*data-ipad-tablet-dose="1">[^]*?<\/div>/g, '')
    .replace(/<script data-ipad-tablet-dose="1">[^]*?<\/script>/g, '');
}

function build(html, namespace) {
  const stable = strip(html);
  const label = '<span class="metric-label">pH-Wert</span>';
  const labelAt = stable.indexOf(label);
  if (labelAt < 0 || !stable.includes('</html>')) return { stable, html: stable, ok: false, reason: 'pH-Kachel oder vollständiges HTML fehlt' };
  const start = stable.lastIndexOf('<section class="metric-card"', labelAt);
  const end = stable.indexOf('</section>', labelAt);
  if (start < 0 || end < 0) return { stable, html: stable, ok: false, reason: 'pH-Kartenrahmen fehlt' };
  let card = stable.slice(start, end + 10);
  if (!card.includes('<div class="history-wrap">')) return { stable, html: stable, ok: false, reason: 'Verlaufsmarker fehlt' };
  card = card.replace('<div class="history-wrap">', controls() + '<div class="history-wrap">');
  let candidate = stable.slice(0, start) + card + stable.slice(end + 10);
  candidate = candidate.replace('</head>', css() + '</head>').replace('</body>', script(namespace) + '</body>');
  const before = bytes(stable);
  for (const points of [96, 72, 56, 40, 32, 24, 16, 12, 8]) {
    const current = compact(reduceHistory(candidate, points));
    if (current.includes('</html>') && current.includes('data-dose42="60"') && current.includes('data-dose42="180"') && current.includes(VERSION) && bytes(current) < before) {
      return { stable, html: current, ok: true, reason: `${points} Kurvenpunkte`, before, after: bytes(current) };
    }
  }
  return { stable, html: stable, ok: false, reason: 'keine sichere Größenreserve', before, after: before };
}

function valid(html) {
  const value = String(html || '');
  return value.includes('</html>') && value.includes('data-dose42="60"') && value.includes('data-dose42="120"') && value.includes('data-dose42="180"') && value.includes(VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__ipadDose42Installed) return adapter;
  adapter.__ipadDose42Installed = true;

  const safeLog = (level, message) => {
    try {
      if (adapter.log && typeof adapter.log[level] === 'function') adapter.log[level](message);
    } catch {}
  };

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => version(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function apply(logResult) {
    const state = await adapter.getStateAsync(STATE_ID);
    const current = String((state && state.val) || '');
    if (current.length < 1000 || !current.includes('</html>')) return false;
    const result = build(current, adapter.namespace);
    await adapter.setStateIfChanged(STATE_ID, result.html, true);
    const stored = String(((await adapter.getStateAsync(STATE_ID)) || {}).val || '');
    if (result.ok && !valid(stored)) {
      await adapter.setStateAsync(STATE_ID, result.stable, true);
      result.ok = false;
      result.reason = 'Rückleseprüfung fehlgeschlagen; stabile Ansicht wiederhergestellt';
    }
    if (logResult) safeLog(result.ok ? 'info' : 'warn', `[IPAD-MINI] ${VERSION}: Dosierbuttons ${result.ok ? 'aktiv' : 'nicht eingefügt'} | ${result.reason}`);
    return result.ok;
  }

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    try { await apply(false); } catch (error) { safeLog('warn', '[IPAD-MINI] Dosierbuttons konnten nicht erzeugt werden: ' + (error.message || error)); }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [1800, 4800, 8500]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          if (delay === 1800) {
            adapter.lastRenderSignature = '';
            adapter.lastRenderAt = 0;
            await adapter.forceImmediateRender();
          }
          await apply(delay === 4800);
        } catch (error) {
          safeLog('warn', '[IPAD-MINI] Start der Dosierbuttons fehlgeschlagen: ' + (error.message || error));
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

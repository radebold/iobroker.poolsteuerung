'use strict';

const createBase = require('./main-ipadmini-final-050.js');

const VERSION = 'v0.4.51';
const POOLLAB_ID = 'control.ph.calibration.poollabValue';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function buildOpenHandler() {
  return escapeAttribute([
    "event.stopPropagation()",
    "var m=document.getElementById('pool-ph-cal-modal')",
    "var i=document.getElementById('pool-ph-cal-input')",
    "var t=document.getElementById('pool-ph-cal-msg')",
    "if(t){t.textContent='PoolLab-Wert eingeben und speichern.';t.className='pool-ph-cal-msg'}",
    "if(i){i.value=''}",
    "if(m){m.style.display='flex'}",
    "setTimeout(function(){if(i)i.focus()},50)",
    "return false"
  ].join(';'));
}

function buildSaveHandler(namespace) {
  const stateId = `${String(namespace || 'poolsteuerung.0')}.${POOLLAB_ID}`
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

  return escapeAttribute([
    "event.stopPropagation()",
    "var b=this",
    "var i=document.getElementById('pool-ph-cal-input')",
    "var m=document.getElementById('pool-ph-cal-modal')",
    "var t=document.getElementById('pool-ph-cal-msg')",
    "var x=Number(String(i&&i.value||'').trim().replace(',','.'))",
    "if(!Number.isFinite(x)||x<0||x>14){if(t){t.textContent='Bitte einen gültigen pH-Wert eingeben.';t.className='pool-ph-cal-msg error'};if(i)i.focus();return false}",
    "var v=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    "if(!v){if(t){t.textContent='VIS-Verbindung nicht verfügbar.';t.className='pool-ph-cal-msg error'};return false}",
    "b.disabled=true;b.textContent='Speichere …'",
    "var p=null",
    "if(typeof v.setValue==='function')p=Promise.resolve(v.setValue('" + stateId + "',x))",
    "else if(v.conn&&typeof v.conn.setState==='function')p=Promise.resolve(v.conn.setState('" + stateId + "',x))",
    "else p=Promise.reject(new Error('setState nicht verfügbar'))",
    "p.then(function(){if(t){t.textContent='Gespeichert – Kalibrierung wird aktualisiert.';t.className='pool-ph-cal-msg ok'};b.textContent='Gespeichert';setTimeout(function(){if(m)m.style.display='none';b.disabled=false;b.textContent='Speichern'},900)},function(){if(t){t.textContent='Speichern fehlgeschlagen.';t.className='pool-ph-cal-msg error'};b.disabled=false;b.textContent='Speichern'})",
    "return false"
  ].join(';'));
}

function buildModal(namespace) {
  const save = buildSaveHandler(namespace);
  return `<div id="pool-ph-cal-modal" class="pool-ph-cal-modal" style="display:none" onclick="if(event.target===this)this.style.display='none'">
    <div class="pool-ph-cal-box" onclick="event.stopPropagation()">
      <div class="pool-ph-cal-title">PoolLab pH-Kalibrierung</div>
      <div class="pool-ph-cal-sub">Aktuellen PoolLab-Messwert eingeben</div>
      <input id="pool-ph-cal-input" class="pool-ph-cal-input" inputmode="decimal" autocomplete="off" placeholder="z. B. 7,19" onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('pool-ph-cal-save').click()}if(event.key==='Escape'){document.getElementById('pool-ph-cal-modal').style.display='none'}">
      <div id="pool-ph-cal-msg" class="pool-ph-cal-msg">PoolLab-Wert eingeben und speichern.</div>
      <div class="pool-ph-cal-actions">
        <button type="button" class="pool-ph-cal-cancel" onclick="event.stopPropagation();document.getElementById('pool-ph-cal-modal').style.display='none';return false">Abbrechen</button>
        <button id="pool-ph-cal-save" type="button" class="pool-ph-cal-save" onclick="${save}">Speichern</button>
      </div>
    </div>
  </div>`;
}

const STYLE = `<style data-ph-cal-modal="1">
.pool-ph-cal-open{cursor:pointer;position:relative;transition:filter .15s ease,transform .15s ease}
.pool-ph-cal-open:hover{filter:brightness(1.08)}
.pool-ph-cal-open:active{transform:scale(.995)}
.pool-ph-cal-open:after{content:'PoolLab';position:absolute;right:8px;bottom:7px;padding:2px 6px;border-radius:999px;background:rgba(85,200,255,.14);border:1px solid rgba(85,200,255,.25);color:#8edcff;font-size:7px;font-weight:800;letter-spacing:.02em}
.pool-ph-cal-modal{position:fixed;inset:0;z-index:2147483646;align-items:center;justify-content:center;padding:18px;background:rgba(2,8,18,.72);backdrop-filter:blur(5px)}
.pool-ph-cal-box{width:min(360px,92vw);padding:18px;border:1px solid rgba(255,255,255,.13);border-radius:18px;background:linear-gradient(155deg,#173457,#081827);box-shadow:0 24px 65px rgba(0,0,0,.48);color:#fff;font-family:"Segoe UI Variable","Segoe UI",Arial,sans-serif}
.pool-ph-cal-title{font-size:19px;font-weight:750;letter-spacing:-.02em}
.pool-ph-cal-sub{margin-top:3px;color:#a9bdd2;font-size:11px}
.pool-ph-cal-input{width:100%;height:56px;margin-top:15px;border:1px solid rgba(85,200,255,.48);border-radius:12px;background:#061522;color:#fff;padding:6px 12px;font-size:27px;font-weight:750;outline:none}
.pool-ph-cal-input:focus{border-color:#55c8ff;box-shadow:0 0 0 3px rgba(85,200,255,.13)}
.pool-ph-cal-msg{min-height:30px;margin-top:9px;padding:7px 9px;border-radius:9px;background:rgba(85,200,255,.08);color:#b9d8ef;font-size:10px;font-weight:650}
.pool-ph-cal-msg.ok{background:rgba(87,217,110,.11);color:#a9f2b6}.pool-ph-cal-msg.error{background:rgba(255,118,104,.12);color:#ffc1ba}
.pool-ph-cal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.pool-ph-cal-actions button{height:39px;border-radius:10px;padding:0 15px;font-size:11px;font-weight:750;cursor:pointer}
.pool-ph-cal-cancel{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#d8e6f3}
.pool-ph-cal-save{border:0;background:linear-gradient(135deg,#278bd4,#25bfb5);color:#fff;box-shadow:0 8px 20px rgba(38,164,194,.25)}
.pool-ph-cal-save:disabled{opacity:.6;cursor:default}
</style>`;

function injectTabletModal(html, namespace, widget = false) {
  let value = patchVersion(html);
  if (!value || value.includes('data-ph-cal-modal="1"')) return value;

  const open = buildOpenHandler();
  let changed = false;

  if (widget) {
    const marker = '<div class="ps-metric"><div class="ps-kline"><div class="ps-k">pH</div>';
    if (value.includes(marker)) {
      value = value.replace(marker, `<div class="ps-metric pool-ph-cal-open" title="PoolLab-Messwert erfassen" onclick="${open}"><div class="ps-kline"><div class="ps-k">pH</div>`);
      changed = true;
    }
  } else {
    const pattern = /<div class="metric ([^"]*)">\s*<div class="metric-head">\s*<div class="metric-label">pH<\/div>/;
    if (pattern.test(value)) {
      value = value.replace(pattern, `<div class="metric $1 pool-ph-cal-open" title="PoolLab-Messwert erfassen" onclick="${open}">\n        <div class="metric-head">\n          <div class="metric-label">pH</div>`);
      changed = true;
    }
  }

  if (!changed) return value;
  return `${value}${STYLE}${buildModal(namespace)}`;
}

async function harmonizeVersions(adapter) {
  for (const id of VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch {}
  }
}

function install(adapter) {
  if (!adapter || adapter.__phCalVis051Installed) return adapter;
  adapter.__phCalVis051Installed = true;

  if (typeof adapter.buildTabletHtml === 'function') {
    const original = adapter.buildTabletHtml.bind(adapter);
    adapter.buildTabletHtml = data => injectTabletModal(original({ ...(data || {}), adapterVersion: VERSION }), adapter.namespace, false);
  }

  if (typeof adapter.buildTabletWidget === 'function') {
    const original = adapter.buildTabletWidget.bind(adapter);
    adapter.buildTabletWidget = data => injectTabletModal(original({ ...(data || {}), adapterVersion: VERSION }), adapter.namespace, true);
  }

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await harmonizeVersions(adapter);
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      try { await adapter.forceImmediateRender(); } catch {}
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

const createBase = require('./main-ipadmini-final-062.js');

const VERSION = 'v0.4.63';
const IPAD_ID = 'vis.htmlIpadMini';
const EDIT_ID = 'control.ph.calibration.ipadMiniEditing';
const CAPTURE_ID = 'control.ph.calibration.captureRequest';

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fullId(namespace, relativeId) {
  return `${String(namespace || 'poolsteuerung.0')}.${relativeId}`
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function safeVisCode() {
  return [
    'function pv(){',
    'try{if(window.vis)return window.vis}catch(e){}',
    'try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}',
    'try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}',
    'return null}',
    'function pw(id,val){var v=pv();if(!v)return Promise.reject(new Error(\'VIS-Verbindung nicht verfügbar\'));',
    'try{if(typeof v.setValue===\'function\')return Promise.resolve(v.setValue(id,val))}catch(e){}',
    'try{if(v.conn&&typeof v.conn.setState===\'function\')return Promise.resolve(v.conn.setState(id,val))}catch(e){}',
    'return Promise.reject(new Error(\'setState nicht verfügbar\'))}'
  ].join('');
}

function buildToggleHandler(namespace) {
  const editId = fullId(namespace, EDIT_ID);
  return escapeAttribute([
    safeVisCode(),
    `pw('${editId}',this.checked).catch(function(){})`,
    "if(this.checked){var i=document.getElementById('pool-ph-cal-input-063');var t=document.getElementById('pool-ph-cal-msg-063');if(t){t.textContent='PoolLab-Wert eingeben und speichern.';t.className='pool-ph-cal-msg-063'};if(i){i.value='';setTimeout(function(){try{i.focus()}catch(e){}},60)}}"
  ].join(';'));
}

function buildCloseHandler() {
  return escapeAttribute([
    "var c=document.getElementById('pool-ph-cal-toggle-063')",
    "if(c){c.checked=false;try{c.dispatchEvent(new Event('change',{bubbles:true}))}catch(e){try{var ev=document.createEvent('Event');ev.initEvent('change',true,true);c.dispatchEvent(ev)}catch(x){}}}",
    'return false'
  ].join(';'));
}

function buildSaveHandler(namespace) {
  const captureId = fullId(namespace, CAPTURE_ID);
  return escapeAttribute([
    'event.preventDefault()',
    'event.stopPropagation()',
    'var b=this',
    "var i=document.getElementById('pool-ph-cal-input-063')",
    "var t=document.getElementById('pool-ph-cal-msg-063')",
    "var c=document.getElementById('pool-ph-cal-toggle-063')",
    "var x=Number(String(i&&i.value||'').trim().replace(',','.'))",
    "if(!Number.isFinite(x)||x<0||x>14){if(t){t.textContent='Bitte einen gültigen pH-Wert eingeben.';t.className='pool-ph-cal-msg-063 error'};if(i)i.focus();return false}",
    safeVisCode(),
    "var now=Date.now(),req=JSON.stringify({poollab:x,ts:now,nonce:String(now)+'-'+Math.random().toString(36).slice(2)})",
    "b.disabled=true;b.textContent='Speichere …'",
    `pw('${captureId}',req).then(function(){if(t){t.textContent='Messwert übertragen – JSON wird geprüft.';t.className='pool-ph-cal-msg-063 ok'};b.textContent='Übertragen';setTimeout(function(){if(c){c.checked=false;try{c.dispatchEvent(new Event('change',{bubbles:true}))}catch(e){}}b.disabled=false;b.textContent='Speichern'},1400)},function(e){if(t){t.textContent='Übertragung fehlgeschlagen: '+(e&&e.message?e.message:e);t.className='pool-ph-cal-msg-063 error'};b.disabled=false;b.textContent='Speichern'})`,
    'return false'
  ].join(';'));
}

function buildUi(namespace) {
  const toggle = buildToggleHandler(namespace);
  const close = buildCloseHandler();
  const save = buildSaveHandler(namespace);
  return {
    label: '<label for="pool-ph-cal-toggle-063" class="pool-ph-cal-open-063" data-ph-cal-open-063="1">PoolLab</label>',
    html: `<!--PHCAL063-START--><div data-ph-cal-ui-063="1"><style>
.pool-ph-cal-open-063{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border:1px solid rgba(85,200,255,.42);border-radius:999px;background:rgba(30,105,150,.28);color:#a8e5ff;font:760 10px/1 "Segoe UI Variable","Segoe UI",Arial,sans-serif;cursor:pointer;user-select:none;position:absolute;right:14px;top:70px;z-index:20}.pool-ph-cal-open-063:active{transform:scale(.97)}
.pool-ph-cal-toggle-063{position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none}
.pool-ph-cal-modal-063{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(2,8,18,.80);backdrop-filter:blur(5px)}
.pool-ph-cal-toggle-063:checked + .pool-ph-cal-modal-063{display:flex}
.pool-ph-cal-box-063{width:min(390px,92vw);padding:19px;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:linear-gradient(155deg,#173457,#081827);box-shadow:0 24px 65px rgba(0,0,0,.52);color:#fff;font-family:"Segoe UI Variable","Segoe UI",Arial,sans-serif}
.pool-ph-cal-title-063{font-size:20px;font-weight:760}.pool-ph-cal-sub-063{margin-top:3px;color:#a9bdd2;font-size:12px}.pool-ph-cal-input-063{width:100%;height:58px;margin-top:15px;border:1px solid rgba(85,200,255,.5);border-radius:12px;background:#061522;color:#fff;padding:6px 12px;font-size:28px;font-weight:760;outline:none}.pool-ph-cal-input-063:focus{border-color:#55c8ff;box-shadow:0 0 0 3px rgba(85,200,255,.14)}
.pool-ph-cal-msg-063{min-height:32px;margin-top:10px;padding:8px 10px;border-radius:9px;background:rgba(85,200,255,.08);color:#b9d8ef;font-size:11px;font-weight:650}.pool-ph-cal-msg-063.ok{background:rgba(87,217,110,.11);color:#a9f2b6}.pool-ph-cal-msg-063.error{background:rgba(255,118,104,.12);color:#ffc1ba}
.pool-ph-cal-actions-063{display:flex;justify-content:flex-end;gap:10px;margin-top:13px}.pool-ph-cal-actions-063 button{height:42px;border-radius:10px;padding:0 17px;font-size:12px;font-weight:760;cursor:pointer}.pool-ph-cal-cancel-063{border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:#d8e6f3}.pool-ph-cal-save-063{border:0;background:linear-gradient(135deg,#278bd4,#25bfb5);color:#fff}.pool-ph-cal-save-063:disabled{opacity:.62}
</style><input id="pool-ph-cal-toggle-063" class="pool-ph-cal-toggle-063" type="checkbox" onchange="${toggle}"><div class="pool-ph-cal-modal-063" onclick="if(event.target===this){${close}}"><div class="pool-ph-cal-box-063" onclick="event.stopPropagation()"><div class="pool-ph-cal-title-063">PoolLab pH-Kalibrierung</div><div class="pool-ph-cal-sub-063">Aktuellen PoolLab-Messwert erfassen</div><input id="pool-ph-cal-input-063" class="pool-ph-cal-input-063" inputmode="decimal" autocomplete="off" placeholder="z. B. 7,06" onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('pool-ph-cal-save-063').click()}if(event.key==='Escape'){document.getElementById('pool-ph-cal-cancel-063').click()}"><div id="pool-ph-cal-msg-063" class="pool-ph-cal-msg-063">PoolLab-Wert eingeben und speichern.</div><div class="pool-ph-cal-actions-063"><button id="pool-ph-cal-cancel-063" type="button" class="pool-ph-cal-cancel-063" onclick="${close}">Abbrechen</button><button id="pool-ph-cal-save-063" type="button" class="pool-ph-cal-save-063" onclick="${save}">Speichern</button></div></div></div></div><!--PHCAL063-END-->`
  };
}

function patchIpad(htmlValue, namespace) {
  let html = patchVersion(htmlValue);
  if (!html) return html;

  html = html.replace(/<!--PHCAL063-START-->[\s\S]*?<!--PHCAL063-END-->/g, '');
  html = html.replace(/<label\b[^>]*data-ph-cal-open-063="1"[^>]*>PoolLab<\/label>/g, '');
  html = html.replace(/<button\b[^>]*data-ph-cal-open-062="1"[^>]*>PoolLab<\/button>/g, '');

  const label = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = html.indexOf(label);
  if (labelIndex < 0) return html;

  const ui = buildUi(namespace);
  html = html.slice(0, labelIndex) + label + ui.label + html.slice(labelIndex + label.length);
  html += ui.html;
  return html;
}

function install(adapter) {
  if (!adapter || adapter.__phIpadNativeModal063Installed) return adapter;
  adapter.__phIpadNativeModal063Installed = true;

  async function patchState() {
    try {
      const editing = await adapter.getStateAsync(EDIT_ID);
      if (editing && editing.val === true) return;
      const state = await adapter.getStateAsync(IPAD_ID);
      const current = String((state && state.val) || '');
      const next = patchIpad(current, adapter.namespace);
      if (!next || next === current) return;
      const writer = typeof adapter.__originalSetStateIfChanged056 === 'function'
        ? adapter.__originalSetStateIfChanged056.bind(adapter)
        : adapter.setStateIfChanged.bind(adapter);
      await writer(IPAD_ID, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[PH-KAL] iPad-Mini-Dialog 0.4.63 konnte nicht erzeugt werden: ' + (error.message || error));
      }
    }
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchState();
      return result;
    };
  }

  adapter.on('ready', () => {
    for (const delay of [1200, 3500, 8000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        await patchState();
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

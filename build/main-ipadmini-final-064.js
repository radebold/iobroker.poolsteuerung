'use strict';

const createBase = require('./main-ipadmini-final-063.js');

const VERSION = 'v0.4.64';
const IPAD_ID = 'vis.htmlIpadMini';
const POOLLAB_ID = 'control.ph.calibration.poollabValue';
const SAVE_TRIGGER_ID = 'control.ph.calibration.saveTrigger';
const CAPTURE_ID = 'control.ph.calibration.captureRequest';

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function patchIpad(value, namespace) {
  let html = patchVersion(value);
  if (!html) return html;

  html = html.replace(/<!--PHCAL063-START-->[\s\S]*?<!--PHCAL063-END-->/g, '');
  html = html.replace(/<label\b[^>]*data-ph-cal-open-063="1"[^>]*>PoolLab<\/label>/g, '');
  html = html.replace(/<button\b[^>]*data-ph-cal-open-062="1"[^>]*>PoolLab<\/button>/g, '');
  html = html.replace(/<button\b[^>]*data-ph-cal-open-064="1"[^>]*>PoolLab<\/button>/g, '');

  const marker = '<span class="metric-label">pH-Wert</span>';
  const index = html.indexOf(marker);
  if (index < 0) return html;

  const poollabId = `${namespace}.${POOLLAB_ID}`;
  const triggerId = `${namespace}.${SAVE_TRIGGER_ID}`;
  const handler = esc([
    'event.preventDefault()',
    'event.stopPropagation()',
    "var s=prompt('PoolLab pH-Wert eingeben, z. B. 7,06:','')",
    "if(s===null)return false",
    "var x=Number(String(s).trim().replace(',','.'))",
    "if(!Number.isFinite(x)||x<0||x>14){alert('Ungültiger pH-Wert');return false}",
    "var v=null;try{v=window.vis}catch(e){};try{if(!v&&window.parent)v=window.parent.vis}catch(e){};try{if(!v&&window.top)v=window.top.vis}catch(e){}",
    "if(!v){alert('VIS-Verbindung nicht verfügbar');return false}",
    "function w(id,val){if(typeof v.setValue==='function')return Promise.resolve(v.setValue(id,val));if(v.conn&&typeof v.conn.setState==='function')return Promise.resolve(v.conn.setState(id,val));return Promise.reject(new Error('setState nicht verfügbar'))}",
    `w('${poollabId}',x).then(function(){return w('${triggerId}',Date.now())}).then(function(){alert('PoolLab-Wert übertragen')},function(e){alert('Speichern fehlgeschlagen: '+(e&&e.message?e.message:e))})`,
    'return false'
  ].join(';'));

  const button = `<button type="button" data-ph-cal-open-064="1" style="position:absolute;right:14px;top:70px;z-index:30;height:30px;padding:0 12px;border:1px solid rgba(85,200,255,.42);border-radius:999px;background:rgba(30,105,150,.28);color:#a8e5ff;font:760 10px/1 Arial,sans-serif" onclick="${handler}">PoolLab</button>`;
  return html.slice(0, index + marker.length) + button + html.slice(index + marker.length);
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function install(adapter) {
  if (!adapter || adapter.__phFix064Installed) return adapter;
  adapter.__phFix064Installed = true;
  adapter.__phFix064LastTrigger = null;
  adapter.__phFix064Busy = false;

  async function patchIpadState() {
    const state = await adapter.getStateAsync(IPAD_ID);
    const current = String((state && state.val) || '');
    const next = patchIpad(current, adapter.namespace);
    if (!next || next === current) return;
    const writer = typeof adapter.__originalSetStateIfChanged056 === 'function'
      ? adapter.__originalSetStateIfChanged056.bind(adapter)
      : adapter.setStateIfChanged.bind(adapter);
    await writer(IPAD_ID, next, true);
  }

  async function checkSaveTrigger() {
    if (adapter.isShuttingDown || adapter.__phFix064Busy) return;
    adapter.__phFix064Busy = true;
    try {
      const triggerState = await adapter.getStateAsync(SAVE_TRIGGER_ID);
      const trigger = num(triggerState && triggerState.val);
      if (trigger === null || trigger <= 0 || trigger === adapter.__phFix064LastTrigger) return;

      const poollabState = await adapter.getStateAsync(POOLLAB_ID);
      const poollab = num(poollabState && poollabState.val);
      adapter.__phFix064LastTrigger = trigger;
      if (poollab === null || poollab < 0 || poollab > 14) return;

      await adapter.setStateAsync(CAPTURE_ID, JSON.stringify({
        poollab,
        ts: trigger,
        nonce: `save-${trigger}`
      }), false);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[PH-KAL] saveTrigger-Brücke 0.4.64 fehlgeschlagen: ' + (error.message || error));
      }
    } finally {
      adapter.__phFix064Busy = false;
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
      try { await patchIpadState(); } catch {}
      return result;
    };
  }

  adapter.on('ready', () => {
    const start = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(start);
      if (adapter.isShuttingDown) return;
      try {
        const triggerState = await adapter.getStateAsync(SAVE_TRIGGER_ID);
        adapter.__phFix064LastTrigger = num(triggerState && triggerState.val);
        await adapter.setStateIfChanged('control.ph.calibration.ipadMiniEditing', false, true);
        await patchIpadState();
      } catch {}

      const interval = setInterval(() => { checkSaveTrigger().catch(() => {}); }, 1000);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
    }, 1500));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

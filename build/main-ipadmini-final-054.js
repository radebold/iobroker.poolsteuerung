'use strict';

const createBase = require('./main-ipadmini-final-053.js');

const VERSION = 'v0.4.54';
const IPAD_STATE = 'vis.htmlIpadMini';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', IPAD_STATE];

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function patchIpadControls(value) {
  let html = patchVersion(value);
  if (!html || !html.includes('data-scale-controls="1"')) return html;

  html = html
    .replace('grid-template-rows:38px minmax(0,1fr) 38px 38px', 'grid-template-rows:44px minmax(0,1fr) 38px 38px')
    .replace('.scale-controls{display:inline-flex;align-items:center;gap:4px;margin-left:2px}', '.scale-controls{display:inline-flex;align-items:center;gap:10px;margin-left:8px}')
    .replace('.scale-controls button{height:24px;min-width:43px;padding:0 7px;border:1px solid rgba(255,255,255,.13);border-radius:8px;', '.scale-controls button{height:38px;min-width:68px;padding:0 14px;border:1px solid rgba(255,255,255,.16);border-radius:11px;')
    .replace('font:700 8px/1 "Segoe UI Variable","Segoe UI",Arial,sans-serif;', 'font:700 10px/1 "Segoe UI Variable","Segoe UI",Arial,sans-serif;')
    .replace('.scale-controls button[data-scale-state$="restart"]{min-width:49px;', '.scale-controls button[data-scale-state$="restart"]{min-width:78px;')
    .replace('@media(max-width:900px){.scale-controls{gap:3px}.scale-controls button{height:22px;min-width:39px;padding:0 5px;font-size:7px}.scale-controls button[data-scale-state$="restart"]{min-width:45px}}', '@media(max-width:900px){.scale-controls{gap:8px;margin-left:6px}.scale-controls button{height:36px;min-width:64px;padding:0 12px;font-size:10px}.scale-controls button[data-scale-state$="restart"]{min-width:74px}}');

  return html;
}

async function patchStates(adapter) {
  for (const id of VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = id === IPAD_STATE ? patchIpadControls(current) : patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.debug === 'function') {
        adapter.log.debug(`[IPAD-MINI] Touchgrößen-Fix für ${id} fehlgeschlagen: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__ipadScaleTouch054Installed) return adapter;
  adapter.__ipadScaleTouch054Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchStates(adapter);
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
    }, 2200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

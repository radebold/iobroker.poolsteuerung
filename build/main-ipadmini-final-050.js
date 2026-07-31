'use strict';

const createBase = require('./main-ipadmini-final-071.js');

const VERSION = 'v0.5.0';
const CURRENT = '0.5.0';
const TABLET_STATES = ['vis.htmlTablet', 'vis.widgetTablet'];
const ALL_VIS_STATES = [...TABLET_STATES, 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function escapeAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ' ');
}

function updateClickHandler(namespace) {
  const ns = String(namespace || 'poolsteuerung.0').replace(/'/g, "\\'");
  return escapeAttribute(
    "event.preventDefault();event.stopPropagation();" +
    "var b=this,a=b.dataset.available==='1',id='" + ns + ".'+(a?'update.installTrigger':'update.checkTrigger');" +
    "if(a&&!confirm('Poolsteuerung auf '+(b.dataset.target||b.textContent.replace(/[^0-9.]/g,''))+' aktualisieren?'))return false;" +
    "var val=Date.now(),ok=false;" +
    "try{if(typeof window.poolSetState==='function'){var r=window.poolSetState(id,val);ok=r!==false;}}catch(e){}" +
    "try{var v=null;if(!ok&&window.vis)v=window.vis;if(!ok&&!v&&window.parent&&window.parent.vis)v=window.parent.vis;if(!ok&&!v&&window.top&&window.top.vis)v=window.top.vis;if(!ok&&v&&v.conn&&typeof v.conn.setState==='function'){v.conn.setState(id,val);ok=true;}}catch(e){}" +
    "if(!ok){alert('VIS-Verbindung nicht verfügbar');return false;}" +
    "b.textContent=a?'UPDATE STARTET':'PRÜFE …';b.disabled=true;setTimeout(function(){b.disabled=false;},2500);return false;"
  );
}

function removeBrokenRuntime(value) {
  return String(value || '')
    .replace(/<script data-pool-update-runtime-072="1">[\s\S]*?<\/script>/g, '')
    .replace(/\sdata-pool-update-runtime-072="1"/g, '');
}

function patchTablet(value, namespace) {
  let html = patchVersion(removeBrokenRuntime(value));
  if (!html) return html;
  const handler = updateClickHandler(namespace);
  html = html.replace(/<button\b(?=[^>]*data-pool-update-068="1")[^>]*>/gi, tag => {
    let next = tag.replace(/\s+onclick="[^"]*"/i, '');
    if (/\sdata-target="[^"]*"/i.test(next)) {
      next = next.replace(/\sdata-target="[^"]*"/i, '');
    }
    if (!/>$/.test(next)) return next;
    return next.replace(/>$/, ` data-target="" onclick="${handler}">`);
  });
  return html;
}

async function patchExistingStates(adapter) {
  for (const id of ALL_VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = TABLET_STATES.includes(id)
        ? patchTablet(current, adapter.namespace)
        : patchVersion(removeBrokenRuntime(current));
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.config.debugMode) {
        adapter.log.debug(`[VIS] Bereinigung ${id} fehlgeschlagen: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__release050Installed) return adapter;
  adapter.__release050Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchTablet(
      original({ ...(data || {}), adapterVersion: VERSION }),
      adapter.namespace
    );
  }

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(removeBrokenRuntime(
      original({ ...(data || {}), adapterVersion: VERSION })
    ));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates(adapter);
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try { await patchExistingStates(adapter); } catch {}
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      try { await adapter.forceImmediateRender(); } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn(`[VIS] Neuaufbau 0.5.0: ${error.message || error}`);
      }
      try { await patchExistingStates(adapter); } catch {}
      try { await adapter.setStateAsync('update.checkTrigger', Date.now(), true); } catch {}
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info(`[RELEASE] ${VERSION}: defekten 0.4.72-Runtimeblock entfernt; Tablet-VIS neu aufgebaut`);
      }
    }, 2200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

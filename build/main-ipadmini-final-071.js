'use strict';

const createBase = require('./main-ipadmini-final-070.js');

const VERSION = 'v0.4.71';
const TABLET_STATES = ['vis.htmlTablet', 'vis.widgetTablet'];
const ALL_VIS_STATES = [...TABLET_STATES, 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function patchTablet(value) {
  return patchVersion(value)
    .replace(/WP\s+Auto/g, 'Wärmepumpe Auto');
}

async function patchExistingStates(adapter) {
  for (const id of ALL_VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = TABLET_STATES.includes(id) ? patchTablet(current) : patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.config.debugMode) {
        adapter.log.debug(`[TABLET] Wärmepumpen-Beschriftung für ${id} fehlgeschlagen: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__tabletHeatpumpLabel071Installed) return adapter;
  adapter.__tabletHeatpumpLabel071Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchTablet(original({ ...(data || {}), adapterVersion: VERSION }));
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
      await patchExistingStates(adapter);
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
      try { await patchExistingStates(adapter); } catch {}
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info(`[TABLET] ${VERSION}: „WP Auto“ durch „Wärmepumpe Auto“ ersetzt`);
      }
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

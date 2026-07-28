'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.33';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';

function install(adapter) {
  if (!adapter || adapter.__ipadMiniRestoreInstalled) return adapter;
  adapter.__ipadMiniRestoreInstalled = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => String(original({ ...(data || {}), adapterVersion: VERSION }))
      .replace(/v0\.4\.\d+/g, VERSION);
  }

  async function normalizeIpadVersion() {
    const state = await adapter.getStateAsync(IPAD_MINI_STATE);
    if (!state || typeof state.val !== 'string' || state.val.length < 50) return;
    const html = String(state.val).replace(/v0\.4\.\d+/g, VERSION);
    await adapter.setStateIfChanged(IPAD_MINI_STATE, html, true);
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRenderVisFull = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRenderVisFull(...args);
      await normalizeIpadVersion();
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.setStateAsync(IPAD_MINI_STATE, '', true);
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        await adapter.forceImmediateRender();
        await normalizeIpadVersion();
        adapter.log.info('[IPAD-MINI] v0.4.33: vollständige Ansicht wiederhergestellt');
      } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Wiederherstellung fehlgeschlagen: ' + (error.message || error));
      }
    }, 900));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

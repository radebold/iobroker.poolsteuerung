'use strict';

// 0.5.19: Updatefunktion vollständig aus der VIS und Runtime entfernt.
// Basis: 0.5.17 wegen Chlorinator-Single-Owner + 0.5.16 Kurvenglättung.
const createBase = require('./main-ipadmini-final-517.js');

const VERSION = 'v0.5.19';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function stripUpdater(value) {
  let html = patchVersion(value);
  if (!html) return html;

  // Alle bekannten Update-Styles entfernen.
  html = html.replace(/<style\b[^>]*data-pool-update[^>]*>[\s\S]*?<\/style>/gi, '');

  // Alle bekannten Update-Buttons vollständig entfernen.
  html = html.replace(/<button\b(?=[^>]*(?:\bpool-update-btn\b|data-pool-update-[\w-]+\s*=))[^>]*>[\s\S]*?<\/button>/gi, '');

  // Eventuelle verwaiste Wrapper/Abstände aus älteren Builds entfernen.
  html = html.replace(/\s*data-pool-update-[\w-]+="[^"]*"/gi, '');
  return html;
}

function install(adapter) {
  if (!adapter || adapter.__noUpdater519Installed) return adapter;
  adapter.__noUpdater519Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => stripUpdater(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchExistingStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = stripUpdater(current);
        if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.config && adapter.config.debugMode && adapter.log) {
          adapter.log.debug(`[VIS] Update-Bereinigung ${id}: ${error.message || error}`);
        }
      }
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
        await patchExistingStates();
      } catch {}
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info('[VIS 0.5.19] Updatefunktion vollständig entfernt; Versionen werden nur noch manuell installiert.');
      }
    }, 1200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

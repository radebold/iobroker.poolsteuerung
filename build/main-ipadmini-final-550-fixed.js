'use strict';

// 0.5.50 final: Backend aus main-ipadmini-final-550.js,
// VIS weiterhin unveraendert aus 0.5.46. Es wird ausschliesslich die sichtbare
// Versionsnummer ersetzt; keinerlei HTML-Injektion oder Layout-Manipulation.
const createBase = require('./main-ipadmini-final-550.js');
const VERSION = 'v0.5.50';
const VIS_STATES = ['vis.htmlTablet','vis.widgetTablet','vis.htmlPhone','vis.widgetPhone','vis.htmlIpadMini'];

function patchVersion(value) {
  return typeof value === 'string'
    ? value.replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION)
    : value;
}

function install(adapter) {
  if (!adapter || adapter.__visVersion550Fixed) return adapter;
  adapter.__visVersion550Fixed = true;

  // Nur die Rueckgabe der vorhandenen Builder anfassen: Version ersetzen, sonst nichts.
  for (const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = function(data) {
      const result = original({ ...(data || {}), adapterVersion: VERSION });
      return patchVersion(result);
    };
  }

  // Nach einem regulaeren Render nur alte Versionsstrings in bestehenden VIS-States ersetzen.
  // HTML-Struktur, CSS und JavaScript bleiben bytegleich bis auf die Versionsnummer.
  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function(...args) {
      const result = await originalRender(...args);
      for (const id of VIS_STATES) {
        try {
          const state = await adapter.getStateAsync(id);
          if (!state || typeof state.val !== 'string' || !state.val) continue;
          const patched = patchVersion(state.val);
          if (patched !== state.val) await adapter.setStateIfChanged(id, patched, true);
        } catch (e) {
          if (adapter.log && !(adapter.isDbClosedError && adapter.isDbClosedError(e))) {
            adapter.log.debug(`[0.5.50 VIS-Version] ${id}: ${e.message || e}`);
          }
        }
      }
      return result;
    };
  }

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

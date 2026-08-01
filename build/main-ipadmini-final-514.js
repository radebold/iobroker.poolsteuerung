'use strict';

// 0.5.14: reine Testversion für den automatischen Update-Prozess.
// Keine Funktionsänderung gegenüber 0.5.13; lediglich eindeutiger Versionssprung.
const createBase = require('./main-ipadmini-final-513.js');

const VERSION = 'v0.5.14';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__testRelease514Installed) return adapter;
  adapter.__testRelease514Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchExistingStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = patchVersion(current);
        if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.config && adapter.config.debugMode && adapter.log) {
          adapter.log.debug(`[VIS] Versionsanzeige 0.5.14 für ${id}: ${error.message || error}`);
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
      try { await patchExistingStates(); } catch {}
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info('[UPDATE-TEST] v0.5.14 aktiv.');
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

'use strict';

// 0.5.18 Basisfix: Der alte 0.4.70-Timer darf keine Legacy-Trigger mehr
// im 5-Minuten-Takt schreiben. Versionsprüfungen übernimmt ausschließlich
// der Einzel-Updater 5082 über checkNow/installNow.
const createBase = require('./main-ipadmini-final-069.js');

let CURRENT = '0.5.18';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}
const VERSION = `v${CURRENT}`;
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function lockLegacyUpdater(adapter) {
  try {
    Object.defineProperty(adapter, '__githubUpdate068Busy', {
      configurable: true,
      enumerable: false,
      get: () => true,
      set: () => {}
    });
  } catch {
    adapter.__githubUpdate068Busy = true;
  }
}

async function patchExistingStates(adapter) {
  for (const id of VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.config && adapter.config.debugMode) {
        adapter.log.debug(`[UPDATE] Versionsanzeige ${id}: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__updateRefresh070Installed) return adapter;
  adapter.__updateRefresh070Installed = true;
  lockLegacyUpdater(adapter);

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
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
    lockLegacyUpdater(adapter);
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      lockLegacyUpdater(adapter);
      await patchExistingStates(adapter);
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info('[UPDATE] Legacy-Updater 0.4.68/0.4.70 deaktiviert: kein 5-Minuten-Trigger, keine automatische Installation.');
      }
    }, 800));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

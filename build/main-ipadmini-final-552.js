'use strict';

// 0.5.52: ausschliesslich sichtbare VIS-Versionsnummer korrigieren.
// Keine Layout-, CSS-, HTML- oder Regelungs-Aenderungen gegenueber 0.5.51.
const createBase = require('./main-ipadmini-final-551.js');
const VERSION = 'v0.5.52';
const VIS_IDS = [
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
  if (!adapter || adapter.__visVersion552Installed) return adapter;
  adapter.__visVersion552Installed = true;

  // Writer vor weiteren Wrappers sichern. Wir aendern nur fertige String-States.
  const rawSetStateIfChanged = typeof adapter.setStateIfChanged === 'function'
    ? adapter.setStateIfChanged.bind(adapter)
    : null;

  async function patchExistingVisVersions() {
    if (!rawSetStateIfChanged || adapter.isShuttingDown) return;
    for (const id of VIS_IDS) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String(state && state.val || '');
        if (!current) continue;
        const next = patchVersion(current);
        if (next !== current) await rawSetStateIfChanged(id, next, true);
      } catch (error) {
        if (adapter.log && !(typeof adapter.isDbClosedError === 'function' && adapter.isDbClosedError(error))) {
          adapter.log.debug(`[VIS-VERSION 0.5.52] ${id}: ${error.message || error}`);
        }
      }
    }
  }

  // Auch neu erzeugte Builder-Ausgaben nur hinsichtlich der Versionsnummer anpassen.
  for (const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const original = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullVersion552(...args) {
      const result = await original(...args);
      await patchExistingVisVersions();
      return result;
    };
  }

  if (typeof adapter.forceImmediateRender === 'function') {
    const original = adapter.forceImmediateRender.bind(adapter);
    adapter.forceImmediateRender = async function forceImmediateRenderVersion552(...args) {
      const result = await original(...args);
      await patchExistingVisVersions();
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      await patchExistingVisVersions();
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

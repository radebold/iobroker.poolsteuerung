'use strict';

const createBase = require('./main-ipadmini-final-512.js');

const VERSION = 'v0.5.13';
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

function dedupeUpdateButtons(value) {
  let html = patchVersion(value);
  if (!html) return html;

  const buttonRe = /<button\b(?=[^>]*(?:\bpool-update-btn\b|data-pool-update-[\w-]+="1"))[^>]*>[\s\S]*?<\/button>/gi;
  const matches = [...html.matchAll(buttonRe)];
  if (matches.length <= 1) return html;

  // Bevorzugt den Button der aktuellen Einzel-Runtime; andernfalls den letzten gefundenen.
  let keep = matches[matches.length - 1][0];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (/data-pool-update-single="1"/i.test(matches[i][0])) {
      keep = matches[i][0];
      break;
    }
  }

  html = html.replace(buttonRe, '');

  const normalVersion = /(<span class="ver">[^<]*<\/span>)/i;
  const widgetVersion = /(<span class="ps-ver">[^<]*<\/span>)/i;

  if (normalVersion.test(html)) return html.replace(normalVersion, `$1${keep}`);
  if (widgetVersion.test(html)) return html.replace(widgetVersion, `$1${keep}`);
  return html;
}

function install(adapter) {
  if (!adapter || adapter.__updateButtonDedupe513Installed) return adapter;
  adapter.__updateButtonDedupe513Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => dedupeUpdateButtons(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchExistingStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = dedupeUpdateButtons(current);
        if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.config && adapter.config.debugMode && adapter.log) {
          adapter.log.debug(`[VIS] Update-Button-Bereinigung ${id}: ${error.message || error}`);
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
        adapter.log.info('[VIS] v0.5.13: doppelte Update-Buttons entfernt; genau ein Update-Button bleibt aktiv.');
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

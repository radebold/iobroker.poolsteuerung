'use strict';

// 0.5.41: Versionsanzeige aller VIS-Ausgaben vereinheitlichen.
// Die eigentliche Regel- und pH-Intervalllogik kommt aus 0.5.40.
// Diese Schicht sorgt nur dafuer, dass alle HTML-/Widget-States nach jedem Render
// dieselbe sichtbare Adapterversion tragen. Es werden KEINE zusaetzlichen Voll-
// Render ausgeloest, damit die iPad-Mini-VIS nicht wieder sichtbar flackert.
const createBase = require('./main-ipadmini-final-540.js');

const VERSION = 'v0.5.41';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

function patchVersion(value) {
  let text = String(value || '');
  if (!text) return text;

  // Generische Versionsangaben in den generierten VIS-Dokumenten angleichen.
  // Beispiele: "Pool Manager v0.5.23", "v0.5.37 · iPad Mini", "v0.5.40".
  text = text.replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
  return text;
}

function install(adapter) {
  if (!adapter || adapter.__visVersion541Installed) return adapter;
  adapter.__visVersion541Installed = true;

  const originalSetStateIfChanged = adapter.setStateIfChanged.bind(adapter);

  async function patchExistingVisStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        if (!current) continue;
        const next = patchVersion(current);
        if (next !== current) await originalSetStateIfChanged(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.config && adapter.config.debugMode && adapter.log) {
          adapter.log.error(`[VIS-VERSION 0.5.41] ${id}: ${error.message || error}`);
        }
      }
    }
  }

  // Alle bekannten Builder direkt auf 0.5.41 patchen.
  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  // Nach einem ohnehin stattfindenden Vollrender nur die bereits erzeugten
  // States textlich angleichen. Kein forceImmediateRender, kein Throttle-Reset.
  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullVersion541(...args) {
      const result = await originalRender(...args);
      await patchExistingVisStates();
      return result;
    };
  }

  // Einmal nach dem Start eventuell noch vorhandene Alt-HTMLs korrigieren.
  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      await patchExistingVisStates();
    }, 1200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

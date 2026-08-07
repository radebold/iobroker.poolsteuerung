'use strict';

// 0.5.45: ioBroker-Warnung fuer vis.htmlPhCalibration beseitigen.
// Vor jedem Schreiben auf diesen VIS-State wird das zugehoerige Objekt garantiert.
// Die pH-Regelung und VIS-Logik aus 0.5.44 bleiben unveraendert.
const createBase = require('./main-ipadmini-final-544.js');

const VERSION = 'v0.5.45';
const PH_CAL_VIS_ID = 'vis.htmlPhCalibration';

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationVis545Installed) return adapter;
  adapter.__phCalibrationVis545Installed = true;

  let ensurePromise = null;
  async function ensurePhCalibrationVisObject() {
    if (!ensurePromise) {
      ensurePromise = adapter.setObjectNotExistsAsync(PH_CAL_VIS_ID, {
        type: 'state',
        common: {
          name: 'pH-Kalibrierung VIS HTML',
          type: 'string',
          role: 'html',
          read: true,
          write: false,
          def: ''
        },
        native: {}
      }).catch(error => {
        ensurePromise = null;
        throw error;
      });
    }
    return ensurePromise;
  }

  // Der Adapter nutzt an vielen Stellen setStateIfChanged. Fuer genau diesen
  // State wird das Objekt deshalb vor dem eigentlichen Schreiben angelegt.
  if (typeof adapter.setStateIfChanged === 'function') {
    const originalSetStateIfChanged = adapter.setStateIfChanged.bind(adapter);
    adapter.setStateIfChanged = async function setStateIfChanged545(id, value, ack, ...rest) {
      if (id === PH_CAL_VIS_ID) await ensurePhCalibrationVisObject();
      if (typeof value === 'string') value = patchVersion(value);
      return originalSetStateIfChanged(id, value, ack, ...rest);
    };
  }

  // Fallback fuer direkte asynchrone State-Schreibvorgaenge.
  if (typeof adapter.setStateAsync === 'function') {
    const originalSetStateAsync = adapter.setStateAsync.bind(adapter);
    adapter.setStateAsync = async function setStateAsync545(id, ...args) {
      if (id === PH_CAL_VIS_ID) await ensurePhCalibrationVisObject();
      return originalSetStateAsync(id, ...args);
    };
  }

  // Zusaetzlich beim Ready einmal explizit anlegen. Der Lazy-Guard oben verhindert
  // die Warnung auch dann, wenn vorher bereits geschrieben werden sollte.
  adapter.on('ready', () => {
    ensurePhCalibrationVisObject().catch(error => {
      if (adapter.log) adapter.log.error(`[0.5.45] ${PH_CAL_VIS_ID} konnte nicht angelegt werden: ${error.message || error}`);
    });
  });

  // Sichtbare Versionsnummer der bekannten Builder nachziehen.
  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

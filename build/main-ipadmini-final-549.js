'use strict';

// 0.5.49: fehlende pH-Kalibrierungsobjekte dauerhaft absichern.
const createBase = require('./main-ipadmini-final-548.js');
const VERSION = 'v0.5.49';

const REQUIRED = {
  'status.phCalibration.lastPollTs': {
    type: 'state', common: { name: 'Zeitstempel letzte pH-Kalibrierungsabfrage', type: 'number', role: 'value.time', read: true, write: false, def: 0 }, native: {}
  },
  'status.phCalibration.poolRaw': {
    type: 'state', common: { name: 'Pool pH Rohwert für Kalibrierung', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: false, def: 0 }, native: {}
  },
  'status.phCalibration.poolCorrected': {
    type: 'state', common: { name: 'Pool pH korrigierter Wert für Kalibrierung', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: false, def: 0 }, native: {}
  }
};

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phObjects549Installed) return adapter;
  adapter.__phObjects549Installed = true;
  const ensuring = new Map();

  async function ensureOne(id) {
    if (!REQUIRED[id]) return;
    if (!ensuring.has(id)) {
      const promise = adapter.setObjectNotExistsAsync(id, REQUIRED[id]).catch(error => {
        ensuring.delete(id);
        throw error;
      });
      ensuring.set(id, promise);
    }
    await ensuring.get(id);
  }

  async function ensureAll() {
    for (const id of Object.keys(REQUIRED)) await ensureOne(id);
  }

  if (typeof adapter.setStateIfChanged === 'function') {
    const original = adapter.setStateIfChanged.bind(adapter);
    adapter.setStateIfChanged = async function(id, value, ack, ...rest) {
      if (REQUIRED[id]) await ensureOne(id);
      return original(id, value, ack, ...rest);
    };
  }

  if (typeof adapter.setStateAsync === 'function') {
    const original = adapter.setStateAsync.bind(adapter);
    adapter.setStateAsync = async function(id, ...args) {
      if (REQUIRED[id]) await ensureOne(id);
      return original(id, ...args);
    };
  }

  for (const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  adapter.on('ready', () => {
    ensureAll().then(() => {
      if (adapter.log) adapter.log.info('[PH-KAL 0.5.49] erforderliche Kalibrierungsobjekte vorhanden');
    }).catch(error => {
      if (adapter.log) adapter.log.error('[PH-KAL 0.5.49] Objekte konnten nicht angelegt werden: ' + (error.message || error));
    });
  });

  // Sofortiger Guard, falls ältere ready-Handler sehr früh schreiben.
  ensureAll().catch(() => {});
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

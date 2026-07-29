'use strict';

const createBase = require('./main-ipadmini-final-047.js');

const VERSION = 'v0.4.48';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

const OBJECTS = {
  'control.ph.calibration': {
    type: 'channel',
    common: { name: 'pH-Kalibrierung' },
    native: {}
  },
  'control.ph.calibration.poollabValue': {
    type: 'state',
    common: { name: 'Aktueller PoolLab-pH-Wert', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: true, def: 7.23 },
    native: {}
  },
  'control.ph.calibration.saveTrigger': {
    type: 'state',
    common: { name: 'PoolLab-Messwert speichern', type: 'number', role: 'value.time', read: true, write: true, def: 0 },
    native: {}
  },
  'control.ph.calibration.resetTrigger': {
    type: 'state',
    common: { name: 'Kalibriertabelle löschen', type: 'number', role: 'value.time', read: true, write: true, def: 0 },
    native: {}
  },
  'status.phCalibration': {
    type: 'channel',
    common: { name: 'Status pH-Kalibrierung' },
    native: {}
  },
  'status.phCalibration.pointsJson': {
    type: 'state',
    common: { name: 'Kalibrierpunkte', type: 'string', role: 'json', read: true, write: false, def: '[]' },
    native: {}
  },
  'status.phCalibration.initialized': {
    type: 'state',
    common: { name: 'Kalibrierung initialisiert', type: 'boolean', role: 'indicator', read: true, write: false, def: false },
    native: {}
  },
  'status.phCalibration.count': {
    type: 'state',
    common: { name: 'Anzahl Kalibrierpunkte', type: 'number', role: 'value', read: true, write: false, def: 0 },
    native: {}
  },
  'status.phCalibration.currentRaw': {
    type: 'state',
    common: { name: 'Aktueller PH803-Rohwert', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: false, def: 0 },
    native: {}
  },
  'status.phCalibration.currentCorrected': {
    type: 'state',
    common: { name: 'Aktueller korrigierter pH-Wert', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: false, def: 0 },
    native: {}
  },
  'status.phCalibration.currentDelta': {
    type: 'state',
    common: { name: 'Aktuelle pH-Korrektur', type: 'number', role: 'value', unit: 'pH', read: true, write: false, def: 0 },
    native: {}
  },
  'status.phCalibration.lastPoollab': {
    type: 'state',
    common: { name: 'Letzter PoolLab-Wert', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: false, def: 0 },
    native: {}
  },
  'status.phCalibration.lastRaw': {
    type: 'state',
    common: { name: 'Rohwert beim letzten Kalibrierpunkt', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: false, def: 0 },
    native: {}
  },
  'status.phCalibration.lastSavedTs': {
    type: 'state',
    common: { name: 'Zeitpunkt des letzten Kalibrierpunkts', type: 'number', role: 'value.time', read: true, write: false, def: 0 },
    native: {}
  },
  'status.phCalibration.lastMessage': {
    type: 'state',
    common: { name: 'Letzte Kalibriermeldung', type: 'string', role: 'text', read: true, write: false, def: '' },
    native: {}
  }
};

async function ensureCalibrationObjects(adapter) {
  for (const [id, definition] of Object.entries(OBJECTS)) {
    await adapter.setObjectNotExistsAsync(id, definition);
    if (definition.type !== 'state') continue;
    const state = await adapter.getStateAsync(id);
    if (!state) await adapter.setStateAsync(id, definition.common.def, true);
  }
  if (typeof adapter.subscribeStates === 'function') adapter.subscribeStates('control.ph.calibration.*');

  const required = [
    'control.ph.calibration.poollabValue',
    'control.ph.calibration.saveTrigger',
    'control.ph.calibration.resetTrigger'
  ];
  for (const id of required) {
    const object = await adapter.getObjectAsync(id);
    if (!object) throw new Error(`Kalibrier-State fehlt nach Anlage: ${adapter.namespace}.${id}`);
  }
}

async function harmonizeVersions(adapter) {
  for (const id of VIS_STATES) {
    const state = await adapter.getStateAsync(id);
    const current = String((state && state.val) || '');
    if (!current) continue;
    const next = current.replace(/v0\.4\.\d+/g, VERSION);
    if (next !== current) await adapter.setStateIfChanged(id, next, true);
  }
}

function install(adapter) {
  if (!adapter || adapter.__calibration048Installed) return adapter;
  adapter.__calibration048Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => String(original({ ...(data || {}), adapterVersion: VERSION })).replace(/v0\.4\.\d+/g, VERSION);
  }

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    try { await harmonizeVersions(adapter); }
    catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[VERSION] Harmonisierung auf 0.4.48 fehlgeschlagen: ' + (error.message || error));
      }
    }
    return result;
  };

  adapter.on('ready', async () => {
    try {
      await ensureCalibrationObjects(adapter);
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info('[PH-KAL] v0.4.48: Kalibrier-States angelegt und abonniert');
      }
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      await adapter.forceImmediateRender();
      await harmonizeVersions(adapter);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
        adapter.log.error('[PH-KAL] Kalibrier-States konnten nicht angelegt werden: ' + (error.message || error));
      }
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

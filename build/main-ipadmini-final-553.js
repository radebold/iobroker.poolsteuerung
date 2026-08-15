'use strict';

// 0.5.53 backend guard, corrected for ioBroker lifecycle:
// objects are NEVER created before ready. All pH calibration states are
// explicitly ensured once the adapter is ready and before guarded writes.
const createBase = require('./main-ipadmini-final-552.js');

const REQUIRED_OBJECTS = {
  'status.phCalibration.lastPollTs': { type:'state', common:{ name:'Zeitstempel letzte pH-Kalibrierungsabfrage', type:'number', role:'value.time', read:true, write:false, def:0 }, native:{} },
  'status.phCalibration.poolRaw': { type:'state', common:{ name:'Pool pH Rohwert fuer Kalibrierung', type:'number', role:'value.ph', unit:'pH', read:true, write:false, def:0 }, native:{} },
  'status.phCalibration.poolCorrected': { type:'state', common:{ name:'Pool pH korrigierter Wert fuer Kalibrierung', type:'number', role:'value.ph', unit:'pH', read:true, write:false, def:0 }, native:{} },
  'status.phCalibration.autoDoseBlocked': { type:'state', common:{ name:'Automatische pH-Dosierung blockiert', type:'boolean', role:'indicator', read:true, write:false, def:false }, native:{} },
  'status.phCalibration.autoDoseBlockReason': { type:'state', common:{ name:'Grund der pH-Dosiersperre', type:'string', role:'text', read:true, write:false, def:'' }, native:{} }
};

function install(adapter) {
  if (!adapter || adapter.__phObjectHardGuard553Installed) return adapter;
  adapter.__phObjectHardGuard553Installed = true;

  const inFlight = new Map();
  let ready = false;

  async function objectExists(id) {
    try { return !!(await adapter.getObjectAsync(id)); }
    catch { return false; }
  }

  async function ensureObject(id) {
    const definition = REQUIRED_OBJECTS[id];
    if (!definition) return true;
    if (!ready) return false;
    if (inFlight.has(id)) return inFlight.get(id);

    const promise = (async () => {
      if (!(await objectExists(id))) {
        await adapter.setObjectNotExistsAsync(id, definition);
      }
      if (!(await objectExists(id))) {
        // Second attempt only after ready; avoids the pre-ready _setObject validated crash.
        await adapter.setObjectAsync(id, definition);
      }
      if (!(await objectExists(id))) throw new Error(`Objekt ${id} konnte nicht angelegt/verifiziert werden`);
      return true;
    })().finally(() => inFlight.delete(id));

    inFlight.set(id, promise);
    return promise;
  }

  async function ensureAll() {
    for (const id of Object.keys(REQUIRED_OBJECTS)) await ensureObject(id);
  }

  if (typeof adapter.setStateIfChanged === 'function') {
    const original = adapter.setStateIfChanged.bind(adapter);
    adapter.setStateIfChanged = async function guardedSetStateIfChanged(id, value, ack, ...rest) {
      if (REQUIRED_OBJECTS[id] && ready) await ensureObject(id);
      return original(id, value, ack, ...rest);
    };
  }

  if (typeof adapter.setStateAsync === 'function') {
    const original = adapter.setStateAsync.bind(adapter);
    adapter.setStateAsync = async function guardedSetStateAsync(id, ...args) {
      if (REQUIRED_OBJECTS[id] && ready) await ensureObject(id);
      return original(id, ...args);
    };
  }

  if (typeof adapter.setState === 'function') {
    const original = adapter.setState.bind(adapter);
    adapter.setState = function guardedSetState(id, ...args) {
      if (!REQUIRED_OBJECTS[id] || !ready) return original(id, ...args);
      ensureObject(id)
        .then(() => original(id, ...args))
        .catch(error => adapter.log && adapter.log.error(`[PH-OBJECT] ${error.message || error}`));
      return undefined;
    };
  }

  adapter.on('ready', () => {
    ready = true;
    ensureAll()
      .then(() => adapter.log && adapter.log.info('[PH-OBJECT] pH-Kalibrierungsobjekte verifiziert'))
      .catch(error => adapter.log && adapter.log.error(`[PH-OBJECT] Objektverifikation fehlgeschlagen: ${error.message || error}`));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

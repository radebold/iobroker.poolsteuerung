'use strict';

// 0.5.53: reiner Backend-Fix fuer fehlende pH-Kalibrierungsobjekte.
// VIS/HTML/Layout bleiben vollstaendig auf dem funktionierenden 0.5.52-Stand.
const createBase = require('./main-ipadmini-final-552.js');

const REQUIRED_OBJECTS = {
  'status.phCalibration.lastPollTs': {
    type: 'state',
    common: {
      name: 'Zeitstempel letzte pH-Kalibrierungsabfrage',
      type: 'number',
      role: 'value.time',
      read: true,
      write: false,
      def: 0
    },
    native: {}
  },
  'status.phCalibration.poolRaw': {
    type: 'state',
    common: {
      name: 'Pool pH Rohwert fuer Kalibrierung',
      type: 'number',
      role: 'value.ph',
      unit: 'pH',
      read: true,
      write: false,
      def: 0
    },
    native: {}
  },
  'status.phCalibration.poolCorrected': {
    type: 'state',
    common: {
      name: 'Pool pH korrigierter Wert fuer Kalibrierung',
      type: 'number',
      role: 'value.ph',
      unit: 'pH',
      read: true,
      write: false,
      def: 0
    },
    native: {}
  }
};

function install(adapter) {
  if (!adapter || adapter.__phObjectHardGuard553Installed) return adapter;
  adapter.__phObjectHardGuard553Installed = true;

  const inFlight = new Map();

  async function objectExists(id) {
    try {
      const obj = await adapter.getObjectAsync(id);
      return !!obj;
    } catch {
      return false;
    }
  }

  async function ensureObject(id) {
    const definition = REQUIRED_OBJECTS[id];
    if (!definition) return true;

    if (inFlight.has(id)) return inFlight.get(id);

    const promise = (async () => {
      if (!(await objectExists(id))) {
        // Absichtlich setObjectAsync statt setObjectNotExistsAsync: wir wollen
        // vor dem ersten State-Schreiben sicher wissen, dass das Objekt existiert.
        await adapter.setObjectAsync(id, definition);
      }

      if (!(await objectExists(id))) {
        throw new Error(`Objekt ${id} konnte nicht angelegt/verifiziert werden`);
      }
      return true;
    })().finally(() => inFlight.delete(id));

    inFlight.set(id, promise);
    return promise;
  }

  async function ensureAll() {
    for (const id of Object.keys(REQUIRED_OBJECTS)) await ensureObject(id);
  }

  // Alle gaengigen lokalen Schreibpfade absichern. Die VIS wird dabei nicht beruehrt.
  if (typeof adapter.setStateIfChanged === 'function') {
    const original = adapter.setStateIfChanged.bind(adapter);
    adapter.setStateIfChanged = async function setStateIfChanged553(id, value, ack, ...rest) {
      if (REQUIRED_OBJECTS[id]) await ensureObject(id);
      return original(id, value, ack, ...rest);
    };
  }

  if (typeof adapter.setStateAsync === 'function') {
    const original = adapter.setStateAsync.bind(adapter);
    adapter.setStateAsync = async function setStateAsync553(id, ...args) {
      if (REQUIRED_OBJECTS[id]) await ensureObject(id);
      return original(id, ...args);
    };
  }

  if (typeof adapter.setState === 'function') {
    const original = adapter.setState.bind(adapter);
    adapter.setState = function setState553(id, ...args) {
      if (!REQUIRED_OBJECTS[id]) return original(id, ...args);
      // Callback-/Legacy-Pfad erst nach sicherer Objektanlage ausfuehren.
      ensureObject(id)
        .then(() => original(id, ...args))
        .catch(error => {
          if (adapter.log) adapter.log.error(`[PH-OBJECT 0.5.53] ${error.message || error}`);
        });
      return undefined;
    };
  }

  // Sofort beim Erzeugen der Adapterinstanz starten. Dadurch laufen die
  // Objektanlagen bereits, bevor die spaeteren Poll-/Render-Timer schreiben.
  ensureAll().catch(error => {
    if (adapter.log) adapter.log.error(`[PH-OBJECT 0.5.53] initiale Objektanlage fehlgeschlagen: ${error.message || error}`);
  });

  adapter.on('ready', () => {
    ensureAll()
      .then(() => {
        if (adapter.log) adapter.log.info('[PH-OBJECT 0.5.53] pH-Kalibrierungsobjekte verifiziert');
      })
      .catch(error => {
        if (adapter.log) adapter.log.error(`[PH-OBJECT 0.5.53] Objektverifikation fehlgeschlagen: ${error.message || error}`);
      });
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

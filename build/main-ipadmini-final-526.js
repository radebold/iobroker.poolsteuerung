'use strict';

// 0.5.26: Fehlende Debug-Objekte vor dem ersten Schreibzugriff anlegen.
// Verhindert js-controller-Warnungen wie:
// "State 'poolsteuerung.0.status.debug.lastChlorDecision' has no existing object".
const createBase = require('./main-ipadmini-final-525.js');

const VERSION = 'v0.5.26';
const DEBUG_OBJECTS = {
  'status.debug.lastChlorDecision': { name: 'Letzte Chlorinator-Entscheidung', type: 'string', role: 'text', def: '' },
  'status.debug.lastCycle': { name: 'Letzter Regelzyklus', type: 'string', role: 'text', def: '' },
  'status.debug.lastDecision': { name: 'Letzte Gesamtentscheidung', type: 'string', role: 'text', def: '' },
  'status.debug.lastPhDecision': { name: 'Letzte pH-Entscheidung', type: 'string', role: 'text', def: '' },
  'status.debug.lastPhStartInfo': { name: 'Letzte pH-Startinformation', type: 'string', role: 'text', def: '' },
  'status.debug.lastPumpDecision': { name: 'Letzte Pumpenentscheidung', type: 'string', role: 'text', def: '' },
  'status.debug.lastPumpLoggedDecision': { name: 'Zuletzt protokollierte Pumpenentscheidung', type: 'string', role: 'text', def: '' },
  'status.debug.lastPumpScheduleActive': { name: 'Letzter Pumpen-Zeitplan aktiv', type: 'boolean', role: 'indicator', def: false },
  'status.debug.lastStartupError': { name: 'Letzter Startfehler', type: 'string', role: 'text', def: '' },
  'status.debug.lastVisTrace': { name: 'Letzte VIS-Diagnose', type: 'string', role: 'text', def: '' },
  'status.debug.lastVisUpdate': { name: 'Letzte VIS-Aktualisierung', type: 'string', role: 'text', def: '' }
};

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function localId(adapter, id) {
  const full = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

function install(adapter) {
  if (!adapter || adapter.__debugObjects526Installed) return adapter;
  adapter.__debugObjects526Installed = true;

  const readyObjects = new Set();
  const pendingObjects = new Map();
  const originalSetStateAsync = typeof adapter.setStateAsync === 'function'
    ? adapter.setStateAsync.bind(adapter)
    : null;
  const originalSetStateIfChanged = typeof adapter.setStateIfChanged === 'function'
    ? adapter.setStateIfChanged.bind(adapter)
    : null;

  async function ensureDebugObject(id) {
    const normalized = localId(adapter, id);
    const definition = DEBUG_OBJECTS[normalized];
    if (!definition || readyObjects.has(normalized)) return;
    if (pendingObjects.has(normalized)) return pendingObjects.get(normalized);

    const task = (async () => {
      await adapter.setObjectNotExistsAsync(normalized, {
        type: 'state',
        common: {
          name: definition.name,
          type: definition.type,
          role: definition.role,
          read: true,
          write: false,
          def: definition.def
        },
        native: {}
      });
      readyObjects.add(normalized);
    })();

    pendingObjects.set(normalized, task);
    try {
      await task;
    } finally {
      pendingObjects.delete(normalized);
    }
  }

  async function ensureAllDebugObjects() {
    await adapter.setObjectNotExistsAsync('status.debug', {
      type: 'channel', common: { name: 'Diagnose' }, native: {}
    });
    for (const id of Object.keys(DEBUG_OBJECTS)) {
      try { await ensureDebugObject(id); } catch {}
    }
  }

  if (originalSetStateAsync) {
    adapter.setStateAsync = async function setStateWithDebugObject(id, value, ack, ...args) {
      if (DEBUG_OBJECTS[localId(adapter, id)]) {
        try { await ensureDebugObject(id); } catch {}
      }
      return originalSetStateAsync(id, value, ack, ...args);
    };
  }

  if (originalSetStateIfChanged) {
    adapter.setStateIfChanged = async function setStateIfChangedWithDebugObject(id, value, ack, ...args) {
      if (DEBUG_OBJECTS[localId(adapter, id)]) {
        try { await ensureDebugObject(id); } catch {}
      }
      return originalSetStateIfChanged(id, value, ack, ...args);
    };
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (!adapter.isShuttingDown) await ensureAllDebugObjects();
    }, 100));
  });

  for (const delay of [500, 2000]) {
    const handle = setTimeout(() => {
      if (!adapter.isShuttingDown) ensureAllDebugObjects().catch(() => {});
    }, delay);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(handle);
  }

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

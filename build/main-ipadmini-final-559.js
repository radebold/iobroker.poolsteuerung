'use strict';

// 0.5.59: Backend-Bereinigung ohne VIS-Aenderungen.
// - legt alle tatsaechlich verwendeten pH-Kalibrierungs-/Polling-States VOR dem Schreiben an
// - wartet bei fruehen Schreibzugriffen bis ioBroker ready ist
// - stuft normale Chlor-Schutz-/Bootstrapmeldungen von warn auf info herab
const createBase = require('./main-ipadmini-final-558.js');

const VERSION = '0.5.59';

const REQUIRED = {
  'status.phCalibration.lastPollTs': { type:'number', role:'value.time', name:'Zeitstempel letzte pH-Kalibrierungsabfrage', def:0 },
  'status.phCalibration.poolRaw': { type:'number', role:'value.ph', name:'Pool pH Rohwert fuer Kalibrierung', unit:'pH', def:0 },
  'status.phCalibration.poolCorrected': { type:'number', role:'value.ph', name:'Pool pH korrigierter Wert fuer Kalibrierung', unit:'pH', def:0 },
  'status.phCalibration.pollRaw': { type:'number', role:'value.ph', name:'pH Poll Rohwert', unit:'pH', def:0 },
  'status.phCalibration.pollCorrected': { type:'number', role:'value.ph', name:'pH Poll korrigierter Wert', unit:'pH', def:0 },
  'status.phCalibration.autoDoseBlocked': { type:'boolean', role:'indicator', name:'Automatische pH-Dosierung blockiert', def:false },
  'status.phCalibration.autoDoseBlockReason': { type:'string', role:'text', name:'Grund der pH-Dosiersperre', def:'' }
};

function localId(adapter, id) {
  const s = String(id || '');
  const p = `${adapter.namespace}.`;
  return s.startsWith(p) ? s.slice(p.length) : s;
}

function install(adapter) {
  if (!adapter || adapter.__cleanup559Installed) return adapter;
  adapter.__cleanup559Installed = true;

  let readyResolve;
  let ready = false;
  const readyPromise = new Promise(resolve => { readyResolve = resolve; });
  const ensureInFlight = new Map();

  adapter.on('ready', () => {
    ready = true;
    try { readyResolve(); } catch {}
  });

  async function objectExists(id) {
    try { return !!(await adapter.getObjectAsync(id)); } catch { return false; }
  }

  async function ensureOne(id) {
    id = localId(adapter, id);
    const def = REQUIRED[id];
    if (!def) return;
    if (!ready) await readyPromise;
    if (ensureInFlight.has(id)) return ensureInFlight.get(id);

    const p = (async () => {
      if (await objectExists(id)) return;
      const common = {
        name: def.name,
        type: def.type,
        role: def.role,
        read: true,
        write: false,
        def: def.def
      };
      if (def.unit) common.unit = def.unit;
      await adapter.setObjectAsync(id, { type:'state', common, native:{} });
      if (!(await objectExists(id))) throw new Error(`Objekt ${id} konnte nicht angelegt werden`);
    })().finally(() => ensureInFlight.delete(id));

    ensureInFlight.set(id, p);
    return p;
  }

  async function ensureAll() {
    for (const id of Object.keys(REQUIRED)) await ensureOne(id);
  }

  // Aeusserster Guard: auch alte innere Wrapper duerfen keinen der bekannten States
  // beschreiben, bevor das Objekt nachweislich existiert.
  if (typeof adapter.setStateAsync === 'function') {
    const original = adapter.setStateAsync.bind(adapter);
    adapter.setStateAsync = async function setStateAsync559(id, ...args) {
      const local = localId(adapter, id);
      if (REQUIRED[local]) await ensureOne(local);
      return original(id, ...args);
    };
  }

  if (typeof adapter.setStateIfChanged === 'function') {
    const original = adapter.setStateIfChanged.bind(adapter);
    adapter.setStateIfChanged = async function setStateIfChanged559(id, value, ack, ...rest) {
      const local = localId(adapter, id);
      if (REQUIRED[local]) await ensureOne(local);
      return original(id, value, ack, ...rest);
    };
  }

  // Erwartete Schutzaktionen sind Diagnose, keine Warnung. Wir patchen das Logger-Objekt
  // robust per defineProperty, weil einfache Zuweisungen in aelteren Schichten nicht immer
  // dauerhaft wirksam waren.
  try {
    const logger = adapter.log;
    if (logger && typeof logger.warn === 'function' && !logger.__poolWarn559Patched) {
      const originalWarn = logger.warn.bind(logger);
      const info = typeof logger.info === 'function' ? logger.info.bind(logger) : null;
      const patched = function warn559(msg, ...args) {
        const t = String(msg || '');
        const expected =
          (t.includes('[CHLOR-HARDGUARD 0.5.25]') && t.includes('Bootstrap aktiv')) ||
          (t.includes('[CHLOR-OWNER]') && t.includes('aktiv: zentrale Single-Owner-Hysterese')) ||
          (t.includes('[CHLOR-OWNER 0.5.17]') && t.includes('AUS-Befehl blockiert')) ||
          (t.includes('[CHLOR-OWNER 0.5.17]') && t.includes('unerwartet AUS; EIN wiederhergestellt'));
        if (expected && info) return info(t, ...args);
        return originalWarn(msg, ...args);
      };
      try {
        Object.defineProperty(logger, 'warn', { value: patched, configurable:true, writable:true });
      } catch {
        logger.warn = patched;
      }
      try { Object.defineProperty(logger, '__poolWarn559Patched', { value:true, configurable:true }); } catch { logger.__poolWarn559Patched = true; }
    }
  } catch {}

  adapter.on('ready', () => {
    const h = setTimeout(async () => {
      if (adapter.isShuttingDown) return;
      try {
        await ensureAll();
        if (adapter.log) adapter.log.info(`[CLEANUP] ${VERSION}: pH-Pollobjekte verifiziert; VIS unveraendert.`);
      } catch (e) {
        if (adapter.log) adapter.log.error(`[CLEANUP] ${VERSION}: Objektanlage fehlgeschlagen: ${e.message || e}`);
      }
    }, 150);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(h);
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

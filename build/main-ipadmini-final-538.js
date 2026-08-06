'use strict';

// 0.5.38: Chlorinator-Zustand beim Adapter-Neustart erhalten.
// Wenn der Chlorinator beim Start bereits EIN ist, werden rein startupbedingte
// AUS-Befehle fuer eine kurze Initialisierungsphase blockiert, solange kein echter
// Abschaltgrund vorliegt (ORP > AUS-Schwelle, Pumpe AUS, Automatik AUS, Standby).
const createBase = require('./main-ipadmini-final-537.js');

const VERSION = 'v0.5.38';
const GUARD_MS = 12000;
const DEBUG_ID = 'status.debug.chlorStartupPreserve538';

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'yes', 'ja', 'active', 'aktiv'].includes(String(value ?? '').trim().toLowerCase());
}

function isOffValue(value) {
  if (value === false || value === 0) return true;
  return ['false', '0', 'off', 'aus'].includes(String(value ?? '').trim().toLowerCase());
}

function unwrap(value) {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'val') ? value.val : value;
}

function getTarget(adapter) {
  const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
  if (!chlorId) return null;
  try {
    if (typeof adapter.getTasmotaZigbeeWriteTarget === 'function') {
      const target = adapter.getTasmotaZigbeeWriteTarget(chlorId);
      if (target && target.cmdId && target.device) {
        return { chlorId, cmdId: String(target.cmdId), device: String(target.device) };
      }
    }
  } catch {}
  const match = chlorId.match(/^(.*)\.ZbReceived_(0x[0-9A-Fa-f]+)_Power$/);
  if (!match) return { chlorId, cmdId: '', device: '' };
  return { chlorId, cmdId: `${match[1]}.ZbSend`, device: match[2] };
}

function parseZbSendOff(value, target) {
  let payload = unwrap(value);
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return false; }
  }
  if (!payload || typeof payload !== 'object') return false;
  const send = payload.Send || payload.send;
  if (!send || typeof send !== 'object' || !Object.prototype.hasOwnProperty.call(send, 'Power')) return false;
  const device = String(payload.Device ?? payload.device ?? '').trim().toLowerCase();
  if (target.device && device && device !== String(target.device).trim().toLowerCase()) return false;
  return isOffValue(send.Power);
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__chlorStartupPreserve538Installed) return adapter;
  adapter.__chlorStartupPreserve538Installed = true;

  const installedAt = Date.now();
  let preserveInitiallyOn = false;
  let initialized = false;
  let blockedCount = 0;

  const originalSetForeignStateAsync = typeof adapter.setForeignStateAsync === 'function'
    ? adapter.setForeignStateAsync.bind(adapter)
    : null;
  const originalSetForeignStateChangedAsync = typeof adapter.setForeignStateChangedAsync === 'function'
    ? adapter.setForeignStateChangedAsync.bind(adapter)
    : null;

  async function ensureDebug() {
    await adapter.setObjectNotExistsAsync(DEBUG_ID, {
      type: 'state',
      common: {
        name: 'Chlorinator Startzustand-Erhalt 0.5.38',
        type: 'string', role: 'text', read: true, write: false, def: ''
      },
      native: {}
    });
  }

  async function setDebug(text) {
    try {
      await ensureDebug();
      await adapter.setStateIfChanged(DEBUG_ID, text, true);
    } catch {}
  }

  async function readForeignBool(id) {
    if (!id) return false;
    try {
      const state = await adapter.getForeignStateAsync(id);
      return !!state && boolValue(state.val);
    } catch { return false; }
  }

  async function readForeignNumber(id) {
    if (!id) return null;
    try {
      const state = await adapter.getForeignStateAsync(id);
      return state ? num(state.val) : null;
    } catch { return null; }
  }

  async function autoChlorEnabled() {
    let enabled = !adapter.config || adapter.config.enableChlorControl !== false;
    try {
      const state = await adapter.getStateAsync('control.auto.chlor');
      if (state && state.val !== undefined && state.val !== null) enabled = boolValue(state.val);
    } catch {}
    return enabled;
  }

  async function shouldPreserve() {
    const age = Date.now() - installedAt;
    if (!initialized || !preserveInitiallyOn || age > GUARD_MS) {
      return { preserve: false, reason: age > GUARD_MS ? 'Startschutz abgelaufen' : 'Startzustand war nicht EIN' };
    }

    const cfg = adapter.config || {};
    if (!(await autoChlorEnabled())) return { preserve: false, reason: 'Chlor-Automatik AUS' };
    if (cfg.standbyModeEnabled === true) return { preserve: false, reason: 'Standby aktiv' };

    const pumpId = String(cfg.circulationPumpSocketStateId || '').trim();
    if (pumpId && !(await readForeignBool(pumpId))) return { preserve: false, reason: 'Umwaelzpumpe AUS' };

    const orpId = String(cfg.orpStateId || '').trim();
    const orp = await readForeignNumber(orpId);
    if (!Number.isFinite(orp)) return { preserve: true, reason: 'ORP beim Start noch nicht gueltig; bestehenden EIN-Zustand behalten' };

    const offThreshold = num(cfg.orpOffThreshold) ?? 750;
    if (orp > offThreshold) return { preserve: false, reason: `ORP ${orp} > AUS ${offThreshold}` };

    return { preserve: true, reason: `bestehendes EIN behalten · ORP ${orp} <= AUS ${offThreshold}` };
  }

  async function initSnapshot(reason) {
    if (initialized || adapter.isShuttingDown) return;
    const target = getTarget(adapter);
    if (!target || !target.chlorId) {
      initialized = true;
      await setDebug(`INAKTIV · ${reason} · kein Chlorinator-State konfiguriert`);
      return;
    }

    preserveInitiallyOn = await readForeignBool(target.chlorId);
    initialized = true;
    await setDebug(`${preserveInitiallyOn ? 'ARMED' : 'FREI'} · ${reason} · Startzustand Chlorinator ${preserveInitiallyOn ? 'EIN' : 'AUS'} · Schutz ${GUARD_MS / 1000}s`);
  }

  async function inspect(id, value, source) {
    const target = getTarget(adapter);
    if (!target) return false;

    const directOff = String(id) === target.chlorId && isOffValue(unwrap(value));
    const zbOff = target.cmdId && String(id) === target.cmdId && parseZbSendOff(value, target);
    if (!directOff && !zbOff) return false;

    if (!initialized) await initSnapshot(`erster Schreibzugriff ${source}`);
    const decision = await shouldPreserve();
    if (!decision.preserve) {
      await setDebug(`FREI · ${source} · AUS erlaubt · ${decision.reason}`);
      return false;
    }

    blockedCount += 1;
    await setDebug(`BLOCKIERT ${blockedCount}x · ${source} · startupbedingtes AUS unterdrueckt · ${decision.reason}`);
    if (adapter.log) {
      adapter.log.error(`[CHLOR-START 0.5.38] Startup-AUS blockiert (${source}): ${decision.reason}`);
    }
    return true;
  }

  if (originalSetForeignStateAsync) {
    adapter.setForeignStateAsync = async function preserveChlorOnStartup(id, value, ...args) {
      if (await inspect(id, value, 'setForeignStateAsync')) return { id: String(id), notChanged: true };
      return originalSetForeignStateAsync(id, value, ...args);
    };
  }

  if (originalSetForeignStateChangedAsync) {
    adapter.setForeignStateChangedAsync = async function preserveChlorChangedOnStartup(id, value, ...args) {
      if (await inspect(id, value, 'setForeignStateChangedAsync')) return { id: String(id), notChanged: true };
      return originalSetForeignStateChangedAsync(id, value, ...args);
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
      if (adapter.isShuttingDown) return;
      await initSnapshot('ready');
    }, 100));
  });

  // Fallback, falls die Wrapper-Schicht das ready-Event spaet registriert hat.
  const fallback = setTimeout(() => { initSnapshot('fallback').catch(() => {}); }, 700);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(fallback);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

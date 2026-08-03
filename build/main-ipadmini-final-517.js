'use strict';

// 0.5.17: Chlorinator Single-Owner-Guard + fest angelegte Diagnoseobjekte.
// Basis 0.5.16 enthält weiterhin die geglätteten VIS-Kurven.
const createBase = require('./main-ipadmini-final-516.js');

const VERSION = 'v0.5.17';
const DEBUG_CHANNEL = 'status.debug';
const IDS = {
  guard: 'status.debug.chlorGuardState',
  suppressedCount: 'status.debug.chlorSuppressedOffCount',
  lastSuppressed: 'status.debug.lastChlorSuppressedOff',
  lastReassert: 'status.debug.chlorLastReassert',
  lastStack: 'status.debug.chlorLastOffStack',
  owner: 'status.debug.chlorSingleOwner',
  directCount: 'status.debug.chlorDirectOffBlockedCount'
};

function numberValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'yes', 'ja'].includes(String(value ?? '').trim().toLowerCase());
}

function isOffValue(value) {
  if (value === false || value === 0 || value === null) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'false' || normalized === '0' || normalized === 'off' || normalized === 'aus';
}

function compactStack(stack) {
  return String(stack || '')
    .split('\n')
    .slice(2, 9)
    .map(line => line.trim())
    .join(' | ')
    .slice(0, 1800);
}

function install(adapter) {
  if (!adapter || adapter.__chlorSingleOwner517Installed) return adapter;
  adapter.__chlorSingleOwner517Installed = true;

  let latchedOn = null;
  let objectsReady = false;
  let supervisorBusy = false;
  let reassertBusy = false;
  let lastWarnAt = 0;

  const originalSetSwitch = typeof adapter.setSwitchStateCompat === 'function'
    ? adapter.setSwitchStateCompat.bind(adapter)
    : null;
  const originalForceOff = typeof adapter.forceSwitchOffCompat === 'function'
    ? adapter.forceSwitchOffCompat.bind(adapter)
    : null;
  const originalForceOn = typeof adapter.forceSwitchOnCompat === 'function'
    ? adapter.forceSwitchOnCompat.bind(adapter)
    : null;
  const originalSetForeignStateAsync = typeof adapter.setForeignStateAsync === 'function'
    ? adapter.setForeignStateAsync.bind(adapter)
    : null;
  const originalSetForeignStateChangedAsync = typeof adapter.setForeignStateChangedAsync === 'function'
    ? adapter.setForeignStateChangedAsync.bind(adapter)
    : null;

  async function createState(id, common) {
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
  }

  async function ensureObjects() {
    await adapter.setObjectNotExistsAsync(DEBUG_CHANNEL, {
      type: 'channel',
      common: { name: 'Diagnose' },
      native: {}
    });
    await createState(IDS.guard, {
      name: 'Chlorinator Guard-Status', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.suppressedCount, {
      name: 'Unterdrückte Chlorinator-AUS-Befehle', type: 'number', role: 'value', read: true, write: false, def: 0
    });
    await createState(IDS.lastSuppressed, {
      name: 'Letzter unterdrückter Chlorinator-AUS-Befehl', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.lastReassert, {
      name: 'Letztes erzwungenes Chlorinator-EIN', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.lastStack, {
      name: 'Aufrufpfad des letzten AUS-Befehls', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.owner, {
      name: 'Chlorinator Single-Owner-Modus', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.directCount, {
      name: 'Direkt blockierte Chlorinator-AUS-Schreibzugriffe', type: 'number', role: 'value', read: true, write: false, def: 0
    });
    objectsReady = true;
    await adapter.setStateAsync(
      IDS.owner,
      '0.5.17 aktiv: Der Pooladapter besitzt genau eine gültige Chlor-Entscheidung; AUS nur bei ORP über Ausschaltgrenze oder echter Sicherheitsbedingung.',
      true
    );
  }

  async function readForeign(id) {
    if (!id) return null;
    try { return await adapter.getForeignStateAsync(id); } catch { return null; }
  }

  async function readBool(id) {
    const state = await readForeign(id);
    return !!state && boolValue(state.val);
  }

  async function readNumber(id) {
    const state = await readForeign(id);
    return state ? numberValue(state.val) : null;
  }

  async function evaluate() {
    const cfg = adapter.config || {};
    const chlorId = String(cfg.chlorinatorSocketStateId || '').trim();
    const pumpId = String(cfg.circulationPumpSocketStateId || '').trim();
    const orpId = String(cfg.orpStateId || '').trim();

    if (!chlorId) return { hold: false, allowOff: true, reason: 'kein Chlorinator-Aktor konfiguriert', chlorId };
    if (cfg.enableChlorControl === false) return { hold: false, allowOff: true, reason: 'Chlor-Automatik deaktiviert', chlorId };
    if (cfg.standbyModeEnabled === true) return { hold: false, allowOff: true, reason: 'Standby aktiv', chlorId };

    const pumpOn = await readBool(pumpId);
    if (!pumpOn) {
      latchedOn = false;
      return { hold: false, allowOff: true, reason: 'Umwälzpumpe AUS', chlorId };
    }

    if (
      String(cfg.circulationPumpHeartbeatStateId || '').trim() &&
      Number(cfg.circulationPumpHeartbeatMaxAgeMin || 0) > 0 &&
      typeof adapter.getHeartbeatOk === 'function'
    ) {
      try {
        const heartbeatOk = await adapter.getHeartbeatOk('status.checks.circulationPump');
        if (!heartbeatOk) {
          latchedOn = false;
          return { hold: false, allowOff: true, reason: 'Umwälzpumpen-Heartbeat nicht OK', chlorId };
        }
      } catch {}
    }

    const delaySec = Math.max(0, numberValue(cfg.chlorPumpStartDelaySec) || 0);
    if (delaySec > 0 && typeof adapter.getPumpOnForSec === 'function') {
      const pumpOnForSec = Number(adapter.getPumpOnForSec()) || 0;
      if (pumpOnForSec < delaySec) {
        latchedOn = false;
        return {
          hold: false,
          allowOff: true,
          reason: `Pumpenstart-Verzögerung ${Math.max(0, Math.ceil(delaySec - pumpOnForSec))}s`,
          chlorId
        };
      }
    }

    const orp = await readNumber(orpId);
    if (!Number.isFinite(orp)) {
      latchedOn = false;
      return { hold: false, allowOff: true, reason: 'ORP ungültig', chlorId };
    }

    const onThreshold = numberValue(cfg.orpOnThreshold) ?? 700;
    const offThreshold = numberValue(cfg.orpOffThreshold) ?? 730;
    const currentOn = await readBool(chlorId);

    if (orp <= onThreshold) latchedOn = true;
    else if (orp > offThreshold) latchedOn = false;
    else if (latchedOn === null) latchedOn = currentOn;

    if (latchedOn === true) {
      return {
        hold: true,
        allowOff: false,
        reason: `HOLD EIN · ORP ${orp} mV · EIN<=${onThreshold} / AUS>${offThreshold}`,
        chlorId,
        orp,
        currentOn
      };
    }

    return {
      hold: false,
      allowOff: true,
      reason: `Hysterese AUS · ORP ${orp} mV · EIN<=${onThreshold} / AUS>${offThreshold}`,
      chlorId,
      orp,
      currentOn
    };
  }

  async function increment(id) {
    if (!objectsReady) return;
    try {
      const current = await adapter.getStateAsync(id);
      await adapter.setStateAsync(id, (Number(current && current.val) || 0) + 1, true);
    } catch {}
  }

  async function recordBlocked(source, guard, direct = false) {
    if (!objectsReady) {
      try { await ensureObjects(); } catch {}
    }
    const now = new Date().toISOString();
    try {
      await increment(IDS.suppressedCount);
      if (direct) await increment(IDS.directCount);
      await adapter.setStateAsync(IDS.lastSuppressed, `${now} · ${source} · ${guard.reason}`, true);
      await adapter.setStateAsync(IDS.lastStack, compactStack(new Error('Chlorinator AUS blockiert').stack), true);
      await adapter.setStateAsync(IDS.guard, `AKTIV · ${guard.reason}`, true);
    } catch {}
    if (Date.now() - lastWarnAt > 30000 && adapter.log && typeof adapter.log.warn === 'function') {
      lastWarnAt = Date.now();
      adapter.log.warn(`[CHLOR-OWNER 0.5.17] AUS-Befehl blockiert (${source}): ${guard.reason}`);
    }
  }

  async function mayWriteOff(source, direct = false) {
    const guard = await evaluate();
    if (guard.allowOff) return { allowed: true, guard };
    await recordBlocked(source, guard, direct);
    return { allowed: false, guard };
  }

  if (originalSetSwitch) {
    adapter.setSwitchStateCompat = async function singleOwnerSetSwitch(id, on, ...args) {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && String(id) === chlorId && isOffValue(on)) {
        const decision = await mayWriteOff('setSwitchStateCompat(false)');
        if (!decision.allowed) return true;
      }
      return originalSetSwitch(id, on, ...args);
    };
  }

  if (originalForceOff) {
    adapter.forceSwitchOffCompat = async function singleOwnerForceOff(id, ...args) {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && String(id) === chlorId) {
        const decision = await mayWriteOff('forceSwitchOffCompat()');
        if (!decision.allowed) return true;
      }
      return originalForceOff(id, ...args);
    };
  }

  if (originalSetForeignStateAsync) {
    adapter.setForeignStateAsync = async function singleOwnerForeignWrite(id, value, ...args) {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && String(id) === chlorId && isOffValue(value)) {
        const decision = await mayWriteOff('setForeignStateAsync(false)', true);
        if (!decision.allowed) return { id: String(id), notChanged: true };
      }
      return originalSetForeignStateAsync(id, value, ...args);
    };
  }

  if (originalSetForeignStateChangedAsync) {
    adapter.setForeignStateChangedAsync = async function singleOwnerForeignChangedWrite(id, value, ...args) {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && String(id) === chlorId && isOffValue(value)) {
        const decision = await mayWriteOff('setForeignStateChangedAsync(false)', true);
        if (!decision.allowed) return { id: String(id), notChanged: true };
      }
      return originalSetForeignStateChangedAsync(id, value, ...args);
    };
  }

  async function writeOn(chlorId) {
    if (originalForceOn) return originalForceOn(chlorId);
    if (originalSetSwitch) return originalSetSwitch(chlorId, true);
    if (originalSetForeignStateAsync) return originalSetForeignStateAsync(chlorId, true, false);
    return null;
  }

  async function reassert(guard, source) {
    if (reassertBusy || !guard.hold || !guard.chlorId) return;
    reassertBusy = true;
    try {
      for (const waitMs of [0, 350, 1000]) {
        if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
        const fresh = await evaluate();
        if (!fresh.hold) break;
        const currentOn = await readBool(fresh.chlorId);
        if (!currentOn) await writeOn(fresh.chlorId);
      }
      if (!objectsReady) {
        try { await ensureObjects(); } catch {}
      }
      if (objectsReady) {
        await adapter.setStateAsync(
          IDS.lastReassert,
          `${new Date().toISOString()} · ${source} · Chlorinator EIN erzwungen · ${guard.reason}`,
          true
        );
      }
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[CHLOR-OWNER 0.5.17] Chlorinator unerwartet AUS; EIN wiederhergestellt (${source}): ${guard.reason}`);
      }
    } finally {
      reassertBusy = false;
    }
  }

  async function supervisor() {
    if (adapter.isShuttingDown || supervisorBusy) return;
    supervisorBusy = true;
    try {
      const guard = await evaluate();
      if (!objectsReady) {
        try { await ensureObjects(); } catch {}
      }
      if (objectsReady) {
        await adapter.setStateAsync(IDS.guard, `${guard.hold ? 'AKTIV' : 'FREI'} · ${guard.reason}`, true);
      }
      if (guard.hold && !(await readBool(guard.chlorId))) {
        await reassert(guard, 'Supervisor');
      }
    } catch (error) {
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[CHLOR-OWNER 0.5.17] Supervisor: ${error.message || error}`);
      }
    } finally {
      supervisorBusy = false;
    }
  }

  async function boot() {
    if (adapter.isShuttingDown) return;
    try {
      await ensureObjects();
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && typeof adapter.subscribeForeignStatesAsync === 'function') {
        try { await adapter.subscribeForeignStatesAsync(chlorId); } catch {}
      } else if (chlorId && typeof adapter.subscribeForeignStates === 'function') {
        try { adapter.subscribeForeignStates(chlorId); } catch {}
      }
      await supervisor();
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[CHLOR-OWNER] v0.5.17 aktiv: zentrale Single-Owner-Hysterese und feste Diagnoseobjekte.');
      }
    } catch (error) {
      if (adapter.log && typeof adapter.log.error === 'function') {
        adapter.log.error(`[CHLOR-OWNER 0.5.17] Initialisierung fehlgeschlagen: ${error.message || error}`);
      }
    }
  }

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown) return;
    const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
    if (!chlorId || String(id) !== chlorId || !isOffValue(state.val)) return;
    evaluate()
      .then(guard => {
        if (guard.hold) return reassert(guard, `stateChange ack=${String(state.ack)}`);
        return null;
      })
      .catch(() => {});
  });

  adapter.on('ready', () => {
    setTimeout(() => boot().catch(() => {}), 600);
    const interval = setInterval(() => { supervisor().catch(() => {}); }, 500);
    if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
  });

  // Zusätzlicher Startpfad, falls der Wrapper nach dem ready-Event geladen wurde.
  const fallback = setTimeout(() => boot().catch(() => {}), 2500);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(fallback);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

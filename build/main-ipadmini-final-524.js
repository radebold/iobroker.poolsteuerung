'use strict';

// 0.5.24: Tasmota-Zigbee-Hardguard für den Chlorinator.
// Der konfigurierte Chlor-State ist bei Tasmota ein ZbReceived_*_Power Rückmelde-State.
// Geschaltet wird tatsächlich über <Bridge>.ZbSend. Deshalb schützt diese Schicht
// zusätzlich den echten ZbSend-Befehl und korrigiert unerwartete AUS-Meldungen sofort.
const createBase = require('./main-ipadmini-final-523.js');

const VERSION = 'v0.5.24';
const IDS = {
  hardGuard: 'status.debug.chlorHardGuard524',
  blockedCount: 'status.debug.chlorZbSendBlockedCount',
  lastBlocked: 'status.debug.chlorLastZbSendBlocked',
  externalCount: 'status.debug.chlorExternalZbSendOffCount',
  lastExternal: 'status.debug.chlorLastExternalZbSendOff',
  unexpectedOffCount: 'status.debug.chlorUnexpectedOffCount',
  lastUnexpectedOff: 'status.debug.chlorLastUnexpectedOff'
};

function numberValue(value) {
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
  const txt = String(value ?? '').trim().toLowerCase();
  return ['false', '0', 'off', 'aus'].includes(txt);
}

function unwrapStateValue(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'val')) return value.val;
  return value;
}

function getZigbeeTarget(adapter) {
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
  if (!match) return null;
  return { chlorId, cmdId: `${match[1]}.ZbSend`, device: match[2] };
}

function parseZbSend(value) {
  let raw = unwrapStateValue(value);
  let payload = raw;
  if (typeof raw === 'string') {
    const txt = raw.trim();
    if (!txt) return null;
    try { payload = JSON.parse(txt); } catch { return null; }
  }
  if (!payload || typeof payload !== 'object') return null;
  const send = payload.Send || payload.send;
  if (!send || typeof send !== 'object' || !Object.prototype.hasOwnProperty.call(send, 'Power')) return null;
  return {
    device: String(payload.Device ?? payload.device ?? '').trim(),
    power: send.Power,
    payload
  };
}

function sameDevice(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function localId(adapter, id) {
  const full = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

function install(adapter) {
  if (!adapter || adapter.__chlorZbHardGuard524Installed) return adapter;
  adapter.__chlorZbHardGuard524Installed = true;

  const originalSetForeignStateAsync = typeof adapter.setForeignStateAsync === 'function'
    ? adapter.setForeignStateAsync.bind(adapter)
    : null;
  const originalSetForeignStateChangedAsync = typeof adapter.setForeignStateChangedAsync === 'function'
    ? adapter.setForeignStateChangedAsync.bind(adapter)
    : null;

  let hardLatchedOn = null;
  let correctionBusy = false;
  let objectsReady = false;
  let lastWarnAt = 0;

  async function createState(id, common) {
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
  }

  async function ensureObjects() {
    await adapter.setObjectNotExistsAsync('status.debug', {
      type: 'channel', common: { name: 'Diagnose' }, native: {}
    });
    await createState(IDS.hardGuard, {
      name: 'Chlorinator Tasmota Hardguard', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.blockedCount, {
      name: 'Blockierte Chlorinator ZbSend AUS-Befehle', type: 'number', role: 'value', read: true, write: false, def: 0
    });
    await createState(IDS.lastBlocked, {
      name: 'Letzter blockierter Chlorinator ZbSend AUS-Befehl', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.externalCount, {
      name: 'Beobachtete externe Chlorinator ZbSend AUS-Befehle', type: 'number', role: 'value', read: true, write: false, def: 0
    });
    await createState(IDS.lastExternal, {
      name: 'Letzter beobachteter externer Chlorinator ZbSend AUS-Befehl', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.unexpectedOffCount, {
      name: 'Unerwartete Chlorinator AUS-Rückmeldungen', type: 'number', role: 'value', read: true, write: false, def: 0
    });
    await createState(IDS.lastUnexpectedOff, {
      name: 'Letzte unerwartete Chlorinator AUS-Rückmeldung', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    objectsReady = true;
  }

  async function increment(id) {
    if (!objectsReady) return;
    try {
      const current = await adapter.getStateAsync(id);
      await adapter.setStateAsync(id, (Number(current && current.val) || 0) + 1, true);
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
      return state ? numberValue(state.val) : null;
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

  async function evaluateHold() {
    const cfg = adapter.config || {};
    const target = getZigbeeTarget(adapter);
    if (!target) return { hold: false, reason: 'kein Tasmota-Zigbee-Chlorinator erkannt', target };
    if (!(await autoChlorEnabled())) {
      hardLatchedOn = false;
      return { hold: false, reason: 'Chlor-Automatik AUS', target };
    }
    if (cfg.standbyModeEnabled === true) {
      hardLatchedOn = false;
      return { hold: false, reason: 'Standby aktiv', target };
    }

    const pumpId = String(cfg.circulationPumpSocketStateId || '').trim();
    const pumpOn = await readForeignBool(pumpId);
    if (!pumpOn) {
      hardLatchedOn = false;
      return { hold: false, reason: 'Umwälzpumpe AUS', target };
    }

    if (
      String(cfg.circulationPumpHeartbeatStateId || '').trim() &&
      Number(cfg.circulationPumpHeartbeatMaxAgeMin || 0) > 0 &&
      typeof adapter.getHeartbeatOk === 'function'
    ) {
      try {
        if (!(await adapter.getHeartbeatOk('status.checks.circulationPump'))) {
          hardLatchedOn = false;
          return { hold: false, reason: 'Umwälzpumpen-Heartbeat nicht OK', target };
        }
      } catch {}
    }

    const delaySec = Math.max(0, numberValue(cfg.chlorPumpStartDelaySec) || 0);
    if (delaySec > 0 && typeof adapter.getPumpOnForSec === 'function') {
      const pumpOnForSec = Number(adapter.getPumpOnForSec()) || 0;
      if (pumpOnForSec < delaySec) {
        hardLatchedOn = false;
        return { hold: false, reason: `Pumpenstart-Verzögerung ${Math.ceil(delaySec - pumpOnForSec)}s`, target };
      }
    }

    const orpId = String(cfg.orpStateId || '').trim();
    const orp = await readForeignNumber(orpId);
    if (!Number.isFinite(orp)) {
      hardLatchedOn = false;
      return { hold: false, reason: 'ORP ungültig', target };
    }

    const onThreshold = numberValue(cfg.orpOnThreshold) ?? 700;
    const offThreshold = numberValue(cfg.orpOffThreshold) ?? 730;
    const currentOn = await readForeignBool(target.chlorId);

    if (orp <= onThreshold) hardLatchedOn = true;
    else if (orp > offThreshold) hardLatchedOn = false;
    else if (hardLatchedOn === null) hardLatchedOn = currentOn;

    const hold = hardLatchedOn === true;
    return {
      hold,
      target,
      orp,
      currentOn,
      onThreshold,
      offThreshold,
      reason: `${hold ? 'HOLD EIN' : 'AUS erlaubt'} · ORP ${orp} mV · EIN<=${onThreshold} / AUS>${offThreshold}`
    };
  }

  async function updateGuardState(decision) {
    if (!objectsReady) return;
    try {
      await adapter.setStateAsync(IDS.hardGuard, `${decision.hold ? 'AKTIV' : 'FREI'} · ${decision.reason}`, true);
    } catch {}
  }

  async function recordBlocked(source, decision, payload) {
    if (!objectsReady) {
      try { await ensureObjects(); } catch {}
    }
    await increment(IDS.blockedCount);
    try {
      await adapter.setStateAsync(
        IDS.lastBlocked,
        `${new Date().toISOString()} · ${source} · ${decision.reason} · ${String(payload).slice(0, 500)}`,
        true
      );
      await updateGuardState(decision);
    } catch {}
    if (Date.now() - lastWarnAt > 15000 && adapter.log && typeof adapter.log.warn === 'function') {
      lastWarnAt = Date.now();
      adapter.log.warn(`[CHLOR-HARDGUARD 0.5.24] ZbSend Power:0 blockiert (${source}): ${decision.reason}`);
    }
  }

  async function sendImmediateOn(decision, reason) {
    if (correctionBusy || !decision || !decision.hold || !decision.target || !originalSetForeignStateAsync) return;
    correctionBusy = true;
    try {
      const target = decision.target;
      const onPayload = JSON.stringify({ Device: target.device, Send: { Power: 1 } });
      await originalSetForeignStateAsync(target.cmdId, onPayload, false);

      const readHandle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(readHandle);
        if (adapter.isShuttingDown) return;
        try {
          const fresh = await evaluateHold();
          if (!fresh.hold || !fresh.target || !originalSetForeignStateAsync) return;
          const readPayload = JSON.stringify({ Device: fresh.target.device, Read: { Power: true } });
          await originalSetForeignStateAsync(fresh.target.cmdId, readPayload, false);
        } catch {}
      }, 180));

      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[CHLOR-HARDGUARD 0.5.24] Sofort-EIN gesendet (${reason}): ${decision.reason}`);
      }
    } finally {
      correctionBusy = false;
    }
  }

  async function inspectOutgoing(id, value, source) {
    const target = getZigbeeTarget(adapter);
    if (!target || String(id) !== target.cmdId) return { blocked: false };
    const command = parseZbSend(value);
    if (!command || !sameDevice(command.device, target.device) || !isOffValue(command.power)) return { blocked: false };
    const decision = await evaluateHold();
    await updateGuardState(decision);
    if (!decision.hold) return { blocked: false, decision };
    await recordBlocked(source, decision, JSON.stringify(command.payload));
    return { blocked: true, decision };
  }

  if (originalSetForeignStateAsync) {
    adapter.setForeignStateAsync = async function hardGuardForeignState(id, value, ...args) {
      const inspected = await inspectOutgoing(id, value, 'setForeignStateAsync(ZbSend)');
      if (inspected.blocked) return { id: String(id), notChanged: true };
      return originalSetForeignStateAsync(id, value, ...args);
    };
  }

  if (originalSetForeignStateChangedAsync) {
    adapter.setForeignStateChangedAsync = async function hardGuardForeignChanged(id, value, ...args) {
      const inspected = await inspectOutgoing(id, value, 'setForeignStateChangedAsync(ZbSend)');
      if (inspected.blocked) return { id: String(id), notChanged: true };
      return originalSetForeignStateChangedAsync(id, value, ...args);
    };
  }

  async function handleCommandState(state) {
    const target = getZigbeeTarget(adapter);
    if (!target || !state) return;
    const command = parseZbSend(state.val);
    if (!command || !sameDevice(command.device, target.device) || !isOffValue(command.power)) return;
    const decision = await evaluateHold();
    await updateGuardState(decision);
    if (!decision.hold) return;

    if (!objectsReady) {
      try { await ensureObjects(); } catch {}
    }
    await increment(IDS.externalCount);
    try {
      await adapter.setStateAsync(
        IDS.lastExternal,
        `${new Date().toISOString()} · ack=${String(state.ack)} · from=${String(state.from || '')} · ${decision.reason} · ${JSON.stringify(command.payload).slice(0, 500)}`,
        true
      );
    } catch {}
    await sendImmediateOn(decision, `ZbSend-State ack=${String(state.ack)} from=${String(state.from || '')}`);
  }

  async function handleUnexpectedOff(state) {
    if (!state || !isOffValue(state.val)) return;
    const decision = await evaluateHold();
    await updateGuardState(decision);
    if (!decision.hold) return;

    if (!objectsReady) {
      try { await ensureObjects(); } catch {}
    }
    await increment(IDS.unexpectedOffCount);
    try {
      await adapter.setStateAsync(
        IDS.lastUnexpectedOff,
        `${new Date().toISOString()} · ack=${String(state.ack)} · from=${String(state.from || '')} · ${decision.reason}`,
        true
      );
    } catch {}
    await sendImmediateOn(decision, `Power-Rückmeldung AUS ack=${String(state.ack)} from=${String(state.from || '')}`);
  }

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown) return;
    const target = getZigbeeTarget(adapter);
    if (!target) return;
    if (String(id) === target.cmdId) {
      handleCommandState(state).catch(() => {});
      return;
    }
    if (String(id) === target.chlorId) {
      handleUnexpectedOff(state).catch(() => {});
    }
  });

  async function boot() {
    if (adapter.isShuttingDown) return;
    await ensureObjects();
    const target = getZigbeeTarget(adapter);
    if (target) {
      try {
        if (typeof adapter.subscribeForeignStatesAsync === 'function') {
          await adapter.subscribeForeignStatesAsync(target.cmdId);
          await adapter.subscribeForeignStatesAsync(target.chlorId);
        } else if (typeof adapter.subscribeForeignStates === 'function') {
          adapter.subscribeForeignStates(target.cmdId);
          adapter.subscribeForeignStates(target.chlorId);
        }
      } catch {}
    }
    const decision = await evaluateHold();
    await updateGuardState(decision);
    if (adapter.log && typeof adapter.log.warn === 'function') {
      adapter.log.warn(`[CHLOR-HARDGUARD 0.5.24] Aktiv · ${decision.reason}`);
    }
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      try { await boot(); } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) {
          adapter.log.error(`[CHLOR-HARDGUARD 0.5.24] Initialisierung fehlgeschlagen: ${error.message || error}`);
        }
      }
    }, 700));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

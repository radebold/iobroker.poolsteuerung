'use strict';

// 0.5.17: autoritative Chlorsteuerung.
// Verhindert widersprüchliche AUS-Befehle aus parallelen Render-/Regelpfaden.
const createBase = require('./main-ipadmini-final-516.js');

const VERSION = 'v0.5.17';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];
const STATE = {
  status: 'status.debug.chlorAuthoritativeState',
  blockedCount: 'status.debug.chlorBlockedOffCount',
  lastBlocked: 'status.debug.chlorLastBlockedOff',
  lastReassert: 'status.debug.chlorLastReassert517',
  policy: 'status.debug.chlorControlPolicy517',
  lastObserved: 'status.debug.chlorLastObservedPower'
};

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

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__chlorAuthoritative517Installed) return adapter;
  adapter.__chlorAuthoritative517Installed = true;

  const originalSetSwitch = typeof adapter.setSwitchStateCompat === 'function'
    ? adapter.setSwitchStateCompat.bind(adapter)
    : null;
  const originalForceOff = typeof adapter.forceSwitchOffCompat === 'function'
    ? adapter.forceSwitchOffCompat.bind(adapter)
    : null;
  const originalForceOn = typeof adapter.forceSwitchOnCompat === 'function'
    ? adapter.forceSwitchOnCompat.bind(adapter)
    : null;

  let desiredOn = null;
  let enforcing = false;
  let lastReassertAt = 0;
  let lastBlockedLogAt = 0;

  async function readBool(id) {
    if (!id) return false;
    try {
      if (typeof adapter.getBool === 'function') return await adapter.getBool(id);
      const state = await adapter.getForeignStateAsync(id);
      return boolValue(state && state.val);
    } catch {
      return false;
    }
  }

  async function readNumber(id) {
    if (!id) return null;
    try {
      if (typeof adapter.getNumber === 'function') return await adapter.getNumber(id, null);
      const state = await adapter.getForeignStateAsync(id);
      return num(state && state.val);
    } catch {
      return null;
    }
  }

  async function getControlBool(id, fallback) {
    try {
      if (typeof adapter.getControlBool === 'function') return await adapter.getControlBool(id, fallback);
      const state = await adapter.getStateAsync(id);
      return state && state.val !== undefined ? boolValue(state.val) : !!fallback;
    } catch {
      return !!fallback;
    }
  }

  async function evaluate() {
    const cfg = adapter.config || {};
    const chlorId = String(cfg.chlorinatorSocketStateId || '').trim();
    const pumpId = String(cfg.circulationPumpSocketStateId || '').trim();
    const orpId = String(cfg.orpStateId || '').trim();
    const onThreshold = num(cfg.orpOnThreshold) ?? 700;
    const offThreshold = num(cfg.orpOffThreshold) ?? 730;

    if (!chlorId) return { protect: false, desired: false, reason: 'kein Chlorinator-Aktor', chlorId, pumpId, orpId, onThreshold, offThreshold };

    const standby = await getControlBool('control.standby', cfg.standbyModeEnabled === true);
    if (standby) {
      desiredOn = false;
      return { protect: false, desired: false, reason: 'Standby aktiv', chlorId, pumpId, orpId, onThreshold, offThreshold };
    }

    const autoEnabled = await getControlBool('control.auto.chlor', cfg.enableChlorControl !== false);
    if (!autoEnabled) {
      desiredOn = null;
      return { protect: false, desired: null, reason: 'Chlor-Automatik AUS / manuelle Bedienung', chlorId, pumpId, orpId, onThreshold, offThreshold };
    }

    const pumpOn = await readBool(pumpId);
    if (!pumpOn) {
      desiredOn = false;
      return { protect: false, desired: false, reason: 'Umwälzpumpe AUS', chlorId, pumpId, orpId, pumpOn, onThreshold, offThreshold };
    }

    const delaySec = Math.max(0, num(cfg.chlorPumpStartDelaySec) || 0);
    const pumpOnForSec = typeof adapter.getPumpOnForSec === 'function' ? Number(adapter.getPumpOnForSec()) || 0 : delaySec;
    if (delaySec > 0 && pumpOnForSec < delaySec) {
      desiredOn = false;
      return {
        protect: false,
        desired: false,
        reason: `Pumpenanlauf ${Math.max(0, Math.ceil(delaySec - pumpOnForSec))}s`,
        chlorId, pumpId, orpId, pumpOn, onThreshold, offThreshold
      };
    }

    const orp = await readNumber(orpId);
    if (!Number.isFinite(orp)) {
      desiredOn = false;
      return { protect: false, desired: false, reason: 'ORP ungültig', chlorId, pumpId, orpId, pumpOn, orp, onThreshold, offThreshold };
    }

    const currentOn = await readBool(chlorId);
    if (orp <= onThreshold) desiredOn = true;
    else if (orp > offThreshold) desiredOn = false;
    else if (desiredOn === null) desiredOn = currentOn;

    const reason = desiredOn
      ? `HOLD EIN · ORP ${orp} mV · EIN<=${onThreshold} / AUS>${offThreshold}`
      : `HOLD AUS · ORP ${orp} mV · EIN<=${onThreshold} / AUS>${offThreshold}`;

    return {
      protect: desiredOn === true,
      desired: desiredOn === true,
      reason,
      chlorId, pumpId, orpId, pumpOn, currentOn, orp, onThreshold, offThreshold
    };
  }

  async function recordBlocked(source, decision) {
    try {
      const state = await adapter.getStateAsync(STATE.blockedCount);
      const next = (Number(state && state.val) || 0) + 1;
      await adapter.setStateAsync(STATE.blockedCount, next, true);
      await adapter.setStateAsync(STATE.lastBlocked, `${new Date().toISOString()} · ${source} · ${decision.reason}`, true);
      await adapter.setStateAsync(STATE.status, `AKTIV · ${decision.reason}`, true);
    } catch {}
    if (Date.now() - lastBlockedLogAt > 30000 && adapter.log && typeof adapter.log.warn === 'function') {
      lastBlockedLogAt = Date.now();
      adapter.log.warn(`[CHLOR 0.5.17] Widersprüchlicher AUS-Befehl blockiert (${source}): ${decision.reason}`);
    }
  }

  if (originalSetSwitch) {
    adapter.setSwitchStateCompat = async function authoritativeSetSwitch(id, on, ...args) {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && String(id) === chlorId && !boolValue(on)) {
        const decision = await evaluate();
        if (decision.protect) {
          await recordBlocked('setSwitchStateCompat(false)', decision);
          return true;
        }
      }
      return originalSetSwitch(id, on, ...args);
    };
  }

  if (originalForceOff) {
    adapter.forceSwitchOffCompat = async function authoritativeForceOff(id, ...args) {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && String(id) === chlorId) {
        const decision = await evaluate();
        if (decision.protect) {
          await recordBlocked('forceSwitchOffCompat()', decision);
          return true;
        }
      }
      return originalForceOff(id, ...args);
    };
  }

  async function reassert(reason, decision) {
    if (!decision || !decision.protect || !decision.chlorId) return;
    const now = Date.now();
    if (now - lastReassertAt < 1500) return;
    lastReassertAt = now;
    try {
      if (originalForceOn) await originalForceOn(decision.chlorId);
      else if (originalSetSwitch) await originalSetSwitch(decision.chlorId, true);
      await adapter.setStateAsync(STATE.lastReassert, `${new Date().toISOString()} · ${reason} · ${decision.reason}`, true);
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[CHLOR 0.5.17] Chlorinator wieder EIN gesetzt (${reason}): ${decision.reason}`);
      }
    } catch (error) {
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[CHLOR 0.5.17] Wiedereinschalten fehlgeschlagen: ${error.message || error}`);
      }
    }
  }

  async function supervisor(reason = 'Supervisor') {
    if (adapter.isShuttingDown || enforcing) return;
    enforcing = true;
    try {
      const decision = await evaluate();
      await adapter.setStateAsync(STATE.status, `${decision.protect ? 'AKTIV' : 'FREI'} · ${decision.reason}`, true);
      const current = decision.chlorId ? await readBool(decision.chlorId) : false;
      await adapter.setStateAsync(STATE.lastObserved, `${new Date().toISOString()} · ${current ? 'EIN' : 'AUS'} · ${decision.reason}`, true);
      if (decision.protect && !current) await reassert(reason, decision);
    } finally {
      enforcing = false;
    }
  }

  // Fremde AUS-Meldungen werden unmittelbar behandelt; der 2-s-Supervisor bleibt als Fallback.
  adapter.on('stateChange', (id, state) => {
    try {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (!state || !chlorId || String(id) !== chlorId || boolValue(state.val)) return;
      supervisor('StateChange AUS').catch(() => {});
    } catch {}
  });

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchExistingStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = patchVersion(current);
        if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
      } catch {}
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await supervisor('nach VIS-Render');
      await patchExistingStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const start = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(start);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState(STATE.status, 'string', 'text', '', false);
        await adapter.ensureState(STATE.blockedCount, 'number', 'value', 0, false);
        await adapter.ensureState(STATE.lastBlocked, 'string', 'text', '', false);
        await adapter.ensureState(STATE.lastReassert, 'string', 'text', '', false);
        await adapter.ensureState(STATE.policy, 'string', 'text', '', false);
        await adapter.ensureState(STATE.lastObserved, 'string', 'text', '', false);
        await adapter.setStateAsync(
          STATE.policy,
          '0.5.17: Nur Pumpe, Standby, 30-s-Anlauf und ORP-Hysterese dürfen Chlor AUS freigeben. Heartbeats sind Diagnose und lösen kein Chlor-Takten aus.',
          true
        );
        await patchExistingStates();
        await supervisor('Adapterstart');
      } catch (error) {
        if (adapter.log && typeof adapter.log.warn === 'function') adapter.log.warn(`[CHLOR 0.5.17] Initialisierung: ${error.message || error}`);
      }
      const interval = setInterval(() => { supervisor().catch(() => {}); }, 2000);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[CHLOR 0.5.17] Autoritative ORP-Hysterese aktiv; widersprüchliche AUS-Befehle werden blockiert.');
      }
    }, 1200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

const createBase = require('./main-ipadmini-final-511.js');

const VERSION = 'v0.5.12';
const GUARD_STATE = 'status.debug.chlorGuardState';
const SUPPRESSED_COUNT = 'status.debug.chlorSuppressedOffCount';
const LAST_SUPPRESSED = 'status.debug.lastChlorSuppressedOff';
const LAST_REASSERT = 'status.debug.chlorLastReassert';

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

async function install(adapter) {
  if (!adapter || adapter.__chlorGuard512Installed) return adapter;
  adapter.__chlorGuard512Installed = true;

  let latchedOn = null;
  let lastSuppressedLog = 0;
  let supervisorBusy = false;

  const originalSetSwitch = typeof adapter.setSwitchStateCompat === 'function'
    ? adapter.setSwitchStateCompat.bind(adapter)
    : null;
  const originalForceOff = typeof adapter.forceSwitchOffCompat === 'function'
    ? adapter.forceSwitchOffCompat.bind(adapter)
    : null;
  const originalForceOn = typeof adapter.forceSwitchOnCompat === 'function'
    ? adapter.forceSwitchOnCompat.bind(adapter)
    : null;

  async function readForeignNumber(id) {
    if (!id) return null;
    try {
      const st = await adapter.getForeignStateAsync(id);
      return num(st && st.val);
    } catch {
      return null;
    }
  }

  async function readForeignBool(id) {
    if (!id) return false;
    try {
      if (typeof adapter.getBool === 'function') return await adapter.getBool(id);
      const st = await adapter.getForeignStateAsync(id);
      const v = st && st.val;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      return ['true','1','on','ein','yes','ja'].includes(String(v ?? '').trim().toLowerCase());
    } catch {
      return false;
    }
  }

  async function evaluateGuard() {
    const cfg = adapter.config || {};
    const chlorId = String(cfg.chlorinatorSocketStateId || '').trim();
    const pumpId = String(cfg.circulationPumpSocketStateId || '').trim();
    const orpId = String(cfg.orpStateId || '').trim();

    if (!chlorId) return { hold: false, reason: 'kein Chlorinator-Aktor konfiguriert', chlorId };
    if (cfg.enableChlorControl === false) return { hold: false, reason: 'Chlor-Automatik deaktiviert', chlorId };
    if (cfg.standbyModeEnabled === true) return { hold: false, reason: 'Standby aktiv', chlorId };

    const pumpOn = await readForeignBool(pumpId);
    if (!pumpOn) {
      latchedOn = false;
      return { hold: false, reason: 'Umwälzpumpe AUS', chlorId };
    }

    if (String(cfg.circulationPumpHeartbeatStateId || '').trim() && Number(cfg.circulationPumpHeartbeatMaxAgeMin || 0) > 0 && typeof adapter.getHeartbeatOk === 'function') {
      try {
        const pumpHeartbeatOk = await adapter.getHeartbeatOk('status.checks.circulationPump');
        if (!pumpHeartbeatOk) {
          latchedOn = false;
          return { hold: false, reason: 'Umwälzpumpen-Heartbeat nicht OK', chlorId };
        }
      } catch {}
    }

    const delaySec = Math.max(0, num(cfg.chlorPumpStartDelaySec) || 0);
    if (delaySec > 0 && typeof adapter.getPumpOnForSec === 'function') {
      const pumpOnForSec = Number(adapter.getPumpOnForSec()) || 0;
      if (pumpOnForSec < delaySec) {
        latchedOn = false;
        return { hold: false, reason: `Pumpenstart-Verzögerung ${Math.max(0, Math.ceil(delaySec - pumpOnForSec))}s`, chlorId };
      }
    }

    const orp = await readForeignNumber(orpId);
    if (!Number.isFinite(orp)) {
      latchedOn = false;
      return { hold: false, reason: 'ORP ungültig', chlorId };
    }

    const onThreshold = num(cfg.orpOnThreshold) ?? 725;
    const offThreshold = num(cfg.orpOffThreshold) ?? 750;
    const currentOn = await readForeignBool(chlorId);

    if (orp <= onThreshold) latchedOn = true;
    else if (orp > offThreshold) latchedOn = false;
    else if (latchedOn === null) latchedOn = currentOn;

    if (latchedOn === true) {
      return {
        hold: true,
        reason: `HOLD EIN · ORP ${orp} mV · EIN<=${onThreshold} / AUS>${offThreshold}`,
        chlorId,
        orp,
        onThreshold,
        offThreshold,
        currentOn
      };
    }

    return {
      hold: false,
      reason: `Hysterese AUS · ORP ${orp} mV · EIN<=${onThreshold} / AUS>${offThreshold}`,
      chlorId,
      orp,
      onThreshold,
      offThreshold,
      currentOn
    };
  }

  async function recordSuppressed(source, guard) {
    try {
      const countState = await adapter.getStateAsync(SUPPRESSED_COUNT);
      const next = (Number(countState && countState.val) || 0) + 1;
      await adapter.setStateAsync(SUPPRESSED_COUNT, next, true);
      await adapter.setStateAsync(LAST_SUPPRESSED, `${new Date().toISOString()} · ${source} · ${guard.reason}`, true);
      await adapter.setStateAsync(GUARD_STATE, `AKTIV · ${guard.reason}`, true);
    } catch {}
    if (Date.now() - lastSuppressedLog > 30000 && adapter.log && typeof adapter.log.warn === 'function') {
      lastSuppressedLog = Date.now();
      adapter.log.warn(`[CHLOR-GUARD] AUS-Befehl unterdrückt (${source}): ${guard.reason}`);
    }
  }

  if (originalSetSwitch) {
    adapter.setSwitchStateCompat = async function guardedSetSwitch(id, on, ...args) {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && String(id) === chlorId && !on) {
        const guard = await evaluateGuard();
        if (guard.hold) {
          await recordSuppressed('setSwitchStateCompat(false)', guard);
          return true;
        }
      }
      return originalSetSwitch(id, on, ...args);
    };
  }

  if (originalForceOff) {
    adapter.forceSwitchOffCompat = async function guardedForceOff(id, ...args) {
      const chlorId = String((adapter.config && adapter.config.chlorinatorSocketStateId) || '').trim();
      if (chlorId && String(id) === chlorId) {
        const guard = await evaluateGuard();
        if (guard.hold) {
          await recordSuppressed('forceSwitchOffCompat()', guard);
          return true;
        }
      }
      return originalForceOff(id, ...args);
    };
  }

  async function supervisor() {
    if (adapter.isShuttingDown || supervisorBusy) return;
    supervisorBusy = true;
    try {
      const guard = await evaluateGuard();
      await adapter.setStateAsync(GUARD_STATE, `${guard.hold ? 'AKTIV' : 'FREI'} · ${guard.reason}`, true);
      if (!guard.hold) return;

      const currentOn = await readForeignBool(guard.chlorId);
      if (!currentOn) {
        if (originalForceOn) await originalForceOn(guard.chlorId);
        else if (originalSetSwitch) await originalSetSwitch(guard.chlorId, true);
        await adapter.setStateAsync(LAST_REASSERT, `${new Date().toISOString()} · Chlorinator wieder EIN erzwungen · ${guard.reason}`, true);
        if (adapter.log && typeof adapter.log.warn === 'function') {
          adapter.log.warn(`[CHLOR-GUARD] Chlorinator war unerwartet AUS und wurde wieder EIN gesetzt: ${guard.reason}`);
        }
      }
    } catch (error) {
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[CHLOR-GUARD] Supervisor-Fehler: ${error.message || error}`);
      }
    } finally {
      supervisorBusy = false;
    }
  }

  adapter.on('ready', () => {
    const start = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(start);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState(GUARD_STATE, 'string', 'text', '', false);
        await adapter.ensureState(SUPPRESSED_COUNT, 'number', 'value', 0, false);
        await adapter.ensureState(LAST_SUPPRESSED, 'string', 'text', '', false);
        await adapter.ensureState(LAST_REASSERT, 'string', 'text', '', false);
        await supervisor();
      } catch {}

      const interval = setInterval(() => { supervisor().catch(() => {}); }, 1000);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);

      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[CHLOR-GUARD] v0.5.12 aktiv: zentrale Hysterese-Sperre gegen interne AUS-Taktung.');
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

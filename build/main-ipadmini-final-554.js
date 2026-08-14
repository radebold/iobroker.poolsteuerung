'use strict';

// 0.5.54: Nacht-Reset ueber Admin-UI aktivierbar + Nachhol-Logik.
// VIS bleibt unveraendert auf dem funktionierenden 0.5.53/0.5.52-Stand.
const createBase = require('./main-ipadmini-final-553.js');

const FLAG_ID = 'control.nightlyAutoResetEnabled';
const LAST_ID = 'status.nightlyAutoReset.lastRun';
const DEBUG_ID = 'status.debug.nightlyAutoReset554';

function boolValue(v) {
  if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'val')) v = v.val;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return ['true','1','on','ein','yes','ja','active','aktiv'].includes(String(v ?? '').trim().toLowerCase());
}

function parseTime(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function nowMinutes(d = new Date()) { return d.getHours() * 60 + d.getMinutes(); }
function dayKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function tasmotaTarget(id) {
  const m = String(id || '').match(/^(.*)\.ZbReceived_(0x[0-9A-Fa-f]+)_Power$/);
  return m ? { cmd: `${m[1]}.ZbSend`, device: m[2] } : null;
}

function install(adapter) {
  if (!adapter || adapter.__nightReset554Installed) return adapter;
  adapter.__nightReset554Installed = true;
  let running = false;

  async function ensureObjects() {
    await adapter.setObjectNotExistsAsync(FLAG_ID, {
      type: 'state',
      common: { name: 'Nächtlicher Automatik-Reset aktiv', type: 'boolean', role: 'switch', read: true, write: true, def: false },
      native: {}
    });
    await adapter.setObjectNotExistsAsync(LAST_ID, {
      type: 'state',
      common: { name: 'Letzter nächtlicher Automatik-Reset', type: 'string', role: 'text', read: true, write: false, def: '' },
      native: {}
    });
    await adapter.setObjectNotExistsAsync(DEBUG_ID, {
      type: 'state',
      common: { name: 'Nacht-Reset Diagnose 0.5.54', type: 'string', role: 'text', read: true, write: false, def: '' },
      native: {}
    });
  }

  async function setDebug(text) {
    try { await adapter.setStateIfChanged(DEBUG_ID, text, true); } catch {}
  }

  async function syncFlagState() {
    const enabled = adapter.config && adapter.config.nightlyAutoResetEnabled === true;
    try { await adapter.setStateIfChanged(FLAG_ID, enabled, true); } catch {}
    return enabled;
  }

  async function lastRunWasToday() {
    try {
      const s = await adapter.getStateAsync(LAST_ID);
      const value = String(s && s.val || '').trim();
      if (!value) return false;
      // 0.5.51 speichert de-DE, z.B. 14.8.2026, 22:03:12.
      const now = new Date();
      const dePrefix = `${now.getDate()}.${now.getMonth()+1}.${now.getFullYear()}`;
      const isoPrefix = dayKey(now);
      return value.startsWith(dePrefix) || value.startsWith(isoPrefix);
    } catch { return false; }
  }

  async function switchOff(id, mode, label) {
    id = String(id || '').trim();
    if (!id) return `${label}: nicht konfiguriert`;

    const t = tasmotaTarget(id);
    if (t) {
      await adapter.setForeignStateAsync(t.cmd, JSON.stringify({ Device: t.device, Send: { Power: 0 } }), false);
      return `${label}: AUS via ZbSend`;
    }

    let obj = null;
    try { obj = await adapter.getForeignObjectAsync(id); } catch {}
    if (obj && obj.common && obj.common.write === false) return `${label}: NICHT geschaltet (read-only)`;

    const value = String(mode || '').toLowerCase() === 'num01' || (obj && obj.common && obj.common.type === 'number') ? 0 : false;
    await adapter.setForeignStateAsync(id, value, false);
    return `${label}: AUS`;
  }

  async function enableAuto(id) {
    try {
      const s = await adapter.getStateAsync(id);
      if (!s || !boolValue(s.val)) await adapter.setStateAsync(id, true, false);
      return `${id}: EIN`;
    } catch (e) {
      return `${id}: Fehler ${e && e.message ? e.message : e}`;
    }
  }

  async function runReset(reason) {
    if (running || adapter.isShuttingDown) return;
    running = true;
    try {
      if (!(adapter.config && adapter.config.nightlyAutoResetEnabled === true)) {
        await setDebug(`INAKTIV · ${reason} · Admin-Flag AUS`);
        return;
      }
      if (adapter.config && adapter.config.standbyModeEnabled === true) {
        await setDebug(`ÜBERSPRUNGEN · ${reason} · Standby aktiv`);
        return;
      }
      if (await lastRunWasToday()) {
        await setDebug(`BEREITS ERLEDIGT · ${reason}`);
        return;
      }

      const cfg = adapter.config || {};
      const off = [];
      for (const [id, mode, label] of [
        [cfg.chlorinatorSocketStateId, cfg.chlorinatorWriteMode, 'Chlorinator'],
        [cfg.phPumpSocketStateId, cfg.phPumpWriteMode, 'pH-Dosierpumpe'],
        [cfg.heatpumpPowerStateId, '', 'Wärmepumpe'],
        [cfg.circulationPumpSocketStateId, cfg.circulationPumpWriteMode, 'Umwälzpumpe']
      ]) {
        try { off.push(await switchOff(id, mode, label)); }
        catch (e) { off.push(`${label}: Fehler ${e && e.message ? e.message : e}`); }
      }

      await new Promise(resolve => setTimeout(resolve, 900));

      const autos = [];
      for (const id of ['control.auto.pump','control.auto.chlor','control.auto.ph','control.auto.heatpump']) {
        autos.push(await enableAuto(id));
      }

      const stamp = new Date().toLocaleString('de-DE');
      await adapter.setStateIfChanged(LAST_ID, stamp, true);
      await setDebug(`AUSGEFÜHRT · ${reason} · ${off.join(' | ')} · ${autos.join(' | ')}`);
      if (adapter.log) adapter.log.info(`[NACHT-RESET 0.5.54] ausgeführt · ${reason}`);
    } finally {
      running = false;
    }
  }

  async function checkSchedule(reason = 'Timer') {
    const enabled = await syncFlagState();
    if (!enabled || adapter.isShuttingDown) return;

    const target = parseTime(adapter.config && adapter.config.nightlyAutoResetTime);
    const targetMin = target === null ? 22 * 60 : target;
    const nowMin = nowMinutes();
    if (nowMin < targetMin) return;

    // Ab Zielzeit bis Tagesende einmalig ausführen. Dadurch wird ein verpasster
    // exakter Zeitpunkt nach Adapter-Neustart oder kurzer Downtime nachgeholt.
    await runReset(`${reason} · geplant ${String(Math.floor(targetMin/60)).padStart(2,'0')}:${String(targetMin%60).padStart(2,'0')}`);
  }

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(h);
      if (adapter.isShuttingDown) return;
      await ensureObjects().catch(() => {});
      await syncFlagState();
      await checkSchedule('ready').catch(e => adapter.log && adapter.log.error(`[NACHT-RESET 0.5.54] ${e.message || e}`));
    }, 1200));

    const timer = setInterval(() => {
      if (!adapter.isShuttingDown) checkSchedule('Timer').catch(e => adapter.log && adapter.log.error(`[NACHT-RESET 0.5.54] ${e.message || e}`));
    }, 30000);
    if (typeof adapter.trackInterval === 'function') adapter.trackInterval(timer);
  });

  ensureObjects().catch(() => {});
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

const createBase = require('./main-ipadmini-final-510.js');

const VERSION = 'v0.5.11';
const CHLOR_CHECK_ID = 'status.checks.chlorinator';
const POLICY_ID = 'status.debug.chlorHeartbeatPolicy';
const IGNORED_ID = 'status.debug.chlorHeartbeatIgnored';

function install(adapter) {
  if (!adapter || adapter.__chlorHeartbeatNoCycle511Installed) return adapter;
  adapter.__chlorHeartbeatNoCycle511Installed = true;

  // Wichtig: Der Chlorinator-Heartbeat ist nur Diagnose.
  // Ein veralteter Telemetrie-State darf den laufenden Chlorinator nicht AUS schalten,
  // da sonst bei unregelmäßigen Zigbee-Reports ein AUS/EIN-Takten entsteht.
  // Die sicherheitsrelevanten Freigaben (Umwälzpumpe, Pumpen-Heartbeat,
  // Pumpenstart-Verzögerung, ORP ungültig / ORP-Ausschaltgrenze) bleiben in der
  // bestehenden Regelung unverändert aktiv.
  if (typeof adapter.getHeartbeatOk === 'function') {
    const originalGetHeartbeatOk = adapter.getHeartbeatOk.bind(adapter);
    adapter.getHeartbeatOk = async function patchedGetHeartbeatOk(statusId) {
      const ok = await originalGetHeartbeatOk(statusId);
      if (String(statusId || '') === CHLOR_CHECK_ID && !ok) {
        try {
          await adapter.setStateIfChanged(IGNORED_ID, true, true);
        } catch {}
        if (adapter.config && adapter.config.debugMode && adapter.log && typeof adapter.log.debug === 'function') {
          adapter.log.debug('[CHLOR] Veralteter Chlorinator-Heartbeat wird nur diagnostisch gewertet; keine AUS-Schaltung.');
        }
        return true;
      }
      if (String(statusId || '') === CHLOR_CHECK_ID) {
        try { await adapter.setStateIfChanged(IGNORED_ID, false, true); } catch {}
      }
      return ok;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState(POLICY_ID, 'string', 'text', '', false);
        await adapter.ensureState(IGNORED_ID, 'boolean', 'indicator', false, false);
        await adapter.setStateIfChanged(
          POLICY_ID,
          '0.5.11: Chlorinator-Heartbeat ist nur Diagnose; kein AUS/EIN-Takten. Sicherheitsfreigaben: Pumpe, Pumpen-Heartbeat, Startverzögerung und ORP.',
          true
        );
      } catch {}
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[CHLOR] v0.5.11 Anti-Takt-Hotfix aktiv: Chlorinator-Heartbeat schaltet den Aktor nicht mehr AUS.');
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

'use strict';

// 0.5.25: Robuster Bootstrap fuer den Tasmota-Zigbee-Hardguard aus 0.5.24.
// 0.5.24 registrierte seinen Boot nur am ready-Event. In der langen Wrapper-Kette
// kann dieses Event fuer eine spaete Schicht bereits vorbei sein. 0.5.25 legt die
// Diagnoseobjekte deshalb unabhaengig vom ready-Event an und abonniert ZbSend sowie
// die Power-Rueckmeldung mehrfach/idempotent.
const createBase = require('./main-ipadmini-final-524.js');

const VERSION = 'v0.5.25';
const IDS = {
  hardGuard: 'status.debug.chlorHardGuard524',
  blockedCount: 'status.debug.chlorZbSendBlockedCount',
  lastBlocked: 'status.debug.chlorLastZbSendBlocked',
  externalCount: 'status.debug.chlorExternalZbSendOffCount',
  lastExternal: 'status.debug.chlorLastExternalZbSendOff',
  unexpectedOffCount: 'status.debug.chlorUnexpectedOffCount',
  lastUnexpectedOff: 'status.debug.chlorLastUnexpectedOff'
};

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
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
  if (!match) return null;
  return { chlorId, cmdId: `${match[1]}.ZbSend`, device: match[2] };
}

function install(adapter) {
  if (!adapter || adapter.__chlorHardGuardBootstrap525Installed) return adapter;
  adapter.__chlorHardGuardBootstrap525Installed = true;

  let bootBusy = false;
  let bootOk = false;

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
      name: 'Unerwartete Chlorinator AUS-Rueckmeldungen', type: 'number', role: 'value', read: true, write: false, def: 0
    });
    await createState(IDS.lastUnexpectedOff, {
      name: 'Letzte unerwartete Chlorinator AUS-Rueckmeldung', type: 'string', role: 'text', read: true, write: false, def: ''
    });
  }

  async function subscribeTarget(target) {
    if (!target) return;
    if (typeof adapter.subscribeForeignStatesAsync === 'function') {
      await adapter.subscribeForeignStatesAsync(target.cmdId);
      await adapter.subscribeForeignStatesAsync(target.chlorId);
      return;
    }
    if (typeof adapter.subscribeForeignStates === 'function') {
      adapter.subscribeForeignStates(target.cmdId);
      adapter.subscribeForeignStates(target.chlorId);
    }
  }

  async function bootstrap(source) {
    if (adapter.isShuttingDown || bootBusy) return;
    bootBusy = true;
    try {
      await ensureObjects();
      const target = getTarget(adapter);
      await subscribeTarget(target);

      const text = target
        ? `BOOTSTRAP 0.5.25 aktiv · ZbSend ${target.cmdId} · Device ${target.device} · Power ${target.chlorId}`
        : 'BOOTSTRAP 0.5.25 aktiv · kein Tasmota-Zigbee-Ziel aus chlorinatorSocketStateId ableitbar';
      await adapter.setStateIfChanged(IDS.hardGuard, text, true);
      bootOk = true;

      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[CHLOR-HARDGUARD 0.5.25] Bootstrap aktiv (${source}) · ${text}`);
      }
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
        adapter.log.error(`[CHLOR-HARDGUARD 0.5.25] Bootstrap fehlgeschlagen (${source}): ${error.message || error}`);
      }
    } finally {
      bootBusy = false;
    }
  }

  // Version in allen vorhandenen VIS-Ausgaben konsistent halten.
  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  // Normaler Startpfad.
  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(h);
      await bootstrap('ready');
    }, 250));
  });

  // Unabhaengige Fallbacks: funktionieren auch dann, wenn ready fuer diese Wrapper-Schicht
  // bereits vorbei war. Mehrfaches Abonnieren/Anlegen ist idempotent.
  for (const delay of [1000, 3000, 7000]) {
    const h = setTimeout(async () => {
      try {
        await bootstrap(`fallback-${delay}ms${bootOk ? '-refresh' : ''}`);
      } catch {}
    }, delay);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(h);
  }

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

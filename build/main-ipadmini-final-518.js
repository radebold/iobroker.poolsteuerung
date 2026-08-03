'use strict';

// 0.5.18: Neustart-/Update-Loop endgültig beseitigt.
// - Legacy-Trigger checkTrigger/installTrigger werden intern blockiert.
// - Der alte 0.4.68/0.4.70-Updater bleibt permanent gesperrt.
// - Nur checkNow/installNow des Einzel-Updaters dürfen prüfen/installieren.
// - Keine automatische Installation und keine Neuinstallation derselben Version.
const createBase = require('./main-ipadmini-final-517.js');

const VERSION = 'v0.5.18';
const LEGACY_IDS = new Set(['update.checkTrigger', 'update.installTrigger']);
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];
const STATE_DISABLED = 'update.legacyUpdaterDisabled';
const STATE_COUNT = 'update.legacyTriggerBlockedCount';
const STATE_LAST = 'update.lastLegacyTriggerBlocked';
const STATE_POLICY = 'update.restartProtection';

function localId(adapter, id) {
  const value = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function stateWriteParts(value, ack) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'val')) {
    return { val: value.val, ack: value.ack };
  }
  return { val: value, ack };
}

function isAutomaticLegacyTrigger(value, ack) {
  const parts = stateWriteParts(value, ack);
  if (parts.ack !== true) return false;
  const numeric = Number(parts.val);
  return Number.isFinite(numeric) && numeric !== 0;
}

function lockLegacyUpdater(adapter) {
  try {
    Object.defineProperty(adapter, '__githubUpdate068Busy', {
      configurable: true,
      enumerable: false,
      get: () => true,
      set: () => {}
    });
  } catch {
    adapter.__githubUpdate068Busy = true;
  }
}

function install(adapter) {
  if (!adapter || adapter.__restartProtection518Installed) return adapter;
  adapter.__restartProtection518Installed = true;
  lockLegacyUpdater(adapter);

  const originalSetStateAsync = typeof adapter.setStateAsync === 'function'
    ? adapter.setStateAsync.bind(adapter)
    : null;
  const originalSetStateIfChanged = typeof adapter.setStateIfChanged === 'function'
    ? adapter.setStateIfChanged.bind(adapter)
    : null;

  let blockedCount = 0;
  let diagnosticsReady = false;

  async function ensureState(id, common) {
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
  }

  async function ensureDiagnostics() {
    await adapter.setObjectNotExistsAsync('update', {
      type: 'channel', common: { name: 'GitHub-Update' }, native: {}
    });
    await ensureState(STATE_DISABLED, {
      name: 'Legacy-Updater deaktiviert', type: 'boolean', role: 'indicator', read: true, write: false, def: true
    });
    await ensureState(STATE_COUNT, {
      name: 'Blockierte Legacy-Update-Trigger', type: 'number', role: 'value', read: true, write: false, def: 0
    });
    await ensureState(STATE_LAST, {
      name: 'Letzter blockierter Legacy-Trigger', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await ensureState(STATE_POLICY, {
      name: 'Update-Neustartschutz', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    diagnosticsReady = true;
  }

  async function recordBlocked(id, value) {
    blockedCount += 1;
    if (!diagnosticsReady || !originalSetStateAsync) return;
    try {
      await originalSetStateAsync(STATE_COUNT, blockedCount, true);
      await originalSetStateAsync(
        STATE_LAST,
        `${new Date().toISOString()} · ${localId(adapter, id)}=${JSON.stringify(stateWriteParts(value, true).val)}`,
        true
      );
    } catch {}
  }

  if (originalSetStateAsync) {
    adapter.setStateAsync = async function protectedSetStateAsync(id, value, ack, ...args) {
      const normalized = localId(adapter, id);
      if (LEGACY_IDS.has(normalized) && isAutomaticLegacyTrigger(value, ack)) {
        await recordBlocked(normalized, value);
        return { id: String(id), notChanged: true };
      }
      return originalSetStateAsync(id, value, ack, ...args);
    };
  }

  if (originalSetStateIfChanged) {
    adapter.setStateIfChanged = async function protectedSetStateIfChanged(id, value, ack, ...args) {
      const normalized = localId(adapter, id);
      if (LEGACY_IDS.has(normalized) && isAutomaticLegacyTrigger(value, ack)) {
        await recordBlocked(normalized, value);
        return { id: String(id), notChanged: true };
      }
      return originalSetStateIfChanged(id, value, ack, ...args);
    };
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchExistingStates() {
    if (!originalSetStateAsync) return;
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = patchVersion(current);
        if (next && next !== current) await originalSetStateAsync(id, next, true);
      } catch {}
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates();
      return result;
    };
  }

  async function boot() {
    if (adapter.isShuttingDown || !originalSetStateAsync) return;
    lockLegacyUpdater(adapter);
    await ensureDiagnostics();

    await originalSetStateAsync('update.checkTrigger', 0, true).catch(() => {});
    await originalSetStateAsync('update.installTrigger', 0, true).catch(() => {});
    await originalSetStateAsync('update.checkNow', false, true).catch(() => {});
    await originalSetStateAsync('update.installNow', false, true).catch(() => {});
    await originalSetStateAsync(STATE_DISABLED, true, true);
    await originalSetStateAsync(STATE_COUNT, blockedCount, true);
    await originalSetStateAsync(
      STATE_POLICY,
      '0.5.18: Nur checkNow/installNow. Keine automatische Installation, keine Legacy-Trigger, keine Neuinstallation derselben Version und kein 5-Minuten-Neustart.',
      true
    );

    await patchExistingStates();
    if (adapter.log && typeof adapter.log.info === 'function') {
      adapter.log.info('[UPDATE 0.5.18] Neustartschutz aktiv: Legacy-Updater dauerhaft gesperrt; Updates nur nach explizitem installNow.');
    }
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      try { await boot(); } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) {
          adapter.log.error(`[UPDATE 0.5.18] Neustartschutz: ${error.message || error}`);
        }
      }
    }, 350));
  });

  const fallback = setTimeout(() => {
    if (!adapter.isShuttingDown) boot().catch(() => {});
  }, 3000);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(fallback);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

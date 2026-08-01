'use strict';

const createBase = require('./main-ipadmini-final-5082.js');

const CHECK_NOW = 'update.checkNow';
const INSTALL_NOW = 'update.installNow';
const LAST_BUTTON_RAW = 'update.lastButtonRaw';
const LAST_BUTTON_AT = 'update.lastButtonAt';

function isPressed(value) {
  if (value === true || value === 1) return true;
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

function installNormalizer(adapter) {
  if (!adapter || adapter.__buttonNormalizer510Installed) return adapter;
  adapter.__buttonNormalizer510Installed = true;

  let lastCheckTs = 0;
  let lastInstallTs = 0;
  let booted = false;

  async function ensureDiagnostics() {
    await adapter.setObjectNotExistsAsync(LAST_BUTTON_RAW, {
      type: 'state',
      common: { name: 'Letzter Update-Button-Rohwert', type: 'string', role: 'text', read: true, write: false, def: '' },
      native: {}
    });
    await adapter.setObjectNotExistsAsync(LAST_BUTTON_AT, {
      type: 'state',
      common: { name: 'Letzter Update-Button-Eingang', type: 'number', role: 'value.time', read: true, write: false, def: 0 },
      native: {}
    });
  }

  async function normalizeOne(id, kind) {
    const state = await adapter.getStateAsync(id);
    if (!state || !isPressed(state.val)) return;

    const ts = Number(state.ts) || Date.now();
    if (kind === 'check') {
      if (ts === lastCheckTs) return;
      lastCheckTs = ts;
    } else {
      if (ts === lastInstallTs) return;
      lastInstallTs = ts;
    }

    await adapter.setStateAsync(LAST_BUTTON_RAW, `${kind}: value=${JSON.stringify(state.val)} type=${typeof state.val} ack=${String(state.ack)}`, true);
    await adapter.setStateAsync(LAST_BUTTON_AT, Date.now(), true);

    // Nur normalisieren, wenn ioBroker keinen echten Boolean geliefert hat.
    // Ein echtes true lässt die bestehende 5082-Runtime selbst verarbeiten.
    if (state.val !== true) {
      await adapter.setStateAsync(id, true, false);
      adapter.log.info(`[UPDATE 0.5.10] ${kind} normalisiert: ${JSON.stringify(state.val)} (${typeof state.val}) -> true`);
    }
  }

  async function poll() {
    if (adapter.isShuttingDown) return;
    try {
      await normalizeOne(CHECK_NOW, 'check');
      await normalizeOne(INSTALL_NOW, 'install');
    } catch (error) {
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[UPDATE 0.5.10] Button-Normalizer: ${error.message || error}`);
      }
    }
  }

  async function boot() {
    if (booted || adapter.isShuttingDown) return;
    try {
      await ensureDiagnostics();
      booted = true;
      const interval = setInterval(() => poll().catch(() => {}), 120);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
      adapter.log.info('[UPDATE 0.5.10] Button-Normalizer aktiv');
    } catch (error) {
      const retry = setTimeout(() => boot().catch(() => {}), 1000);
      if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(retry);
    }
  }

  const starter = setTimeout(() => boot().catch(() => {}), 2800);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(starter);
  return adapter;
}

function createAdapter(options = {}) {
  return installNormalizer(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

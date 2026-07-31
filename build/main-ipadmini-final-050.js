'use strict';

const createBase = require('./main-ipadmini-final-049.js');

const VERSION = 'v0.4.50';
const POOLLAB_ID = 'control.ph.calibration.poollabValue';
const SAVE_TRIGGER_ID = 'control.ph.calibration.saveTrigger';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

function parsePh(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 14 ? parsed : null;
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

async function harmonizeVersions(adapter) {
  for (const id of VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.debug === 'function') {
        adapter.log.debug(`[VERSION] ${id} konnte nicht auf ${VERSION} gesetzt werden: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__phAutoSave050Installed) return adapter;
  adapter.__phAutoSave050Installed = true;
  adapter.__phAutoSaveTimer = null;
  adapter.__phExplicitSaveAt = 0;
  adapter.__phAutoSaveReady = false;

  function clearAutoSaveTimer() {
    if (!adapter.__phAutoSaveTimer) return;
    try { clearTimeout(adapter.__phAutoSaveTimer); } catch {}
    adapter.__phAutoSaveTimer = null;
  }

  function scheduleAutoSave(poollabValue) {
    clearAutoSaveTimer();
    adapter.__phAutoSaveTimer = setTimeout(async () => {
      adapter.__phAutoSaveTimer = null;
      if (adapter.isShuttingDown || !adapter.__phAutoSaveReady) return;
      if (Date.now() - adapter.__phExplicitSaveAt < 1200) return;

      try {
        const currentState = await adapter.getStateAsync(POOLLAB_ID);
        const currentValue = parsePh(currentState && currentState.val);
        if (currentValue === null || Math.abs(currentValue - poollabValue) > 0.0001) return;

        await adapter.setStateAsync(POOLLAB_ID, currentValue, true);
        await adapter.setStateAsync(SAVE_TRIGGER_ID, Date.now(), false);

        if (adapter.log && typeof adapter.log.info === 'function') {
          adapter.log.info(`[PH-KAL] PoolLab ${currentValue.toFixed(2)} automatisch zum Speichern ausgelöst`);
        }
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
          adapter.log.warn('[PH-KAL] Automatisches Speichern fehlgeschlagen: ' + (error.message || error));
        }
      }
    }, 600);
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await harmonizeVersions(adapter);
      return result;
    };
  }

  adapter.on('ready', () => {
    try { adapter.subscribeStates('control.ph.calibration.*'); } catch {}
    harmonizeVersions(adapter).catch(() => {});
    const handle = adapter.trackTimeout(setTimeout(() => {
      adapter.pendingTimeouts.delete(handle);
      if (!adapter.isShuttingDown) adapter.__phAutoSaveReady = true;
    }, 2500));
  });

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown || state.ack === true) return;

    const poollabFullId = `${adapter.namespace}.${POOLLAB_ID}`;
    const saveTriggerFullId = `${adapter.namespace}.${SAVE_TRIGGER_ID}`;

    if (id === saveTriggerFullId) {
      adapter.__phExplicitSaveAt = Date.now();
      clearAutoSaveTimer();
      return;
    }

    if (id !== poollabFullId || !adapter.__phAutoSaveReady) return;
    const poollabValue = parsePh(state.val);
    if (poollabValue === null) {
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[PH-KAL] Ungültiger PoolLab-Wert wurde nicht gespeichert: ${state.val}`);
      }
      return;
    }

    scheduleAutoSave(poollabValue);
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

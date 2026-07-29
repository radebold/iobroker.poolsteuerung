'use strict';

const createBase = require('./main-ipadmini-final-047.js');

const VERSION = 'v0.4.49';

const DEFINITIONS = {
  'control.ph.calibration': {
    type: 'channel',
    common: { name: 'pH-Kalibrierung' },
    native: {}
  },
  'control.ph.calibration.poollabValue': {
    type: 'state',
    common: {
      name: 'Aktueller PoolLab-pH-Wert',
      type: 'number',
      role: 'value.ph',
      unit: 'pH',
      read: true,
      write: true,
      def: 7.23
    },
    native: {}
  },
  'control.ph.calibration.saveTrigger': {
    type: 'state',
    common: {
      name: 'PoolLab-Messwert speichern',
      type: 'number',
      role: 'value.time',
      read: true,
      write: true,
      def: 0
    },
    native: {}
  },
  'control.ph.calibration.resetTrigger': {
    type: 'state',
    common: {
      name: 'Kalibriertabelle löschen',
      type: 'number',
      role: 'value.time',
      read: true,
      write: true,
      def: 0
    },
    native: {}
  }
};

async function ensureObject(adapter, id, definition) {
  let object = null;
  try { object = await adapter.getObjectAsync(id); } catch {}

  if (!object) {
    await adapter.setObjectAsync(id, definition);
  } else if (typeof adapter.extendObjectAsync === 'function') {
    await adapter.extendObjectAsync(id, {
      common: definition.common,
      native: definition.native || {}
    });
  }

  if (definition.type === 'state') {
    let state = null;
    try { state = await adapter.getStateAsync(id); } catch {}
    if (!state) await adapter.setStateAsync(id, definition.common.def, true);
  }
}

async function ensureCalibration(adapter, reason) {
  for (const [id, definition] of Object.entries(DEFINITIONS)) {
    await ensureObject(adapter, id, definition);
  }

  if (typeof adapter.subscribeStates === 'function') {
    adapter.subscribeStates('control.ph.calibration.*');
  }

  for (const id of [
    'control.ph.calibration.poollabValue',
    'control.ph.calibration.saveTrigger',
    'control.ph.calibration.resetTrigger'
  ]) {
    const object = await adapter.getObjectAsync(id);
    if (!object) throw new Error(`State fehlt weiterhin: ${adapter.namespace}.${id}`);
  }

  if (!adapter.__calibration049Logged && adapter.log && typeof adapter.log.info === 'function') {
    adapter.__calibration049Logged = true;
    adapter.log.info(`[PH-KAL] ${VERSION}: Kalibrier-States vorhanden (${reason})`);
  }
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__calibration049Installed) return adapter;
  adapter.__calibration049Installed = true;
  adapter.__calibration049Logged = false;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      try { await ensureCalibration(adapter, 'VIS-Render'); }
      catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
          adapter.log.error('[PH-KAL] Laufzeit-Reparatur fehlgeschlagen: ' + (error.message || error));
        }
      }
      const result = await originalRender(...args);
      for (const id of ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini']) {
        try {
          const state = await adapter.getStateAsync(id);
          const current = String((state && state.val) || '');
          const next = patchVersion(current);
          if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
        } catch {}
      }
      return result;
    };
  }

  adapter.on('ready', () => {
    ensureCalibration(adapter, 'ready').catch(error => {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
        adapter.log.error('[PH-KAL] Anlage beim Start fehlgeschlagen: ' + (error.message || error));
      }
    });
  });

  const timer = setTimeout(() => {
    if (adapter.isShuttingDown) return;
    ensureCalibration(adapter, 'Fallback-Timer').catch(error => {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
        adapter.log.error('[PH-KAL] Fallback-Anlage fehlgeschlagen: ' + (error.message || error));
      }
    });
  }, 5000);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

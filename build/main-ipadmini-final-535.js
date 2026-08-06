'use strict';

// 0.5.35: Harte pH-Startschutzschicht gegen Race Conditions beim Adapterstart.
// VIS und pH-Regelung werden erst freigegeben, wenn der echte PH803W-Rohwert
// plausibel verfügbar ist. Bis dahin darf kein anderer State als pH-Ersatz
// verwendet werden; die VIS erhält bewusst keinen numerischen pH-Wert.
const createBase = require('./main-ipadmini-final-534.js');

const VERSION = 'v0.5.35';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const DEBUG_ID = 'status.debug.phStartupGate535';

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function plausiblePoolPh(value) {
  const parsed = num(value);
  return parsed !== null && parsed >= 5.5 && parsed <= 9.5;
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phStartupGate535Installed) return adapter;
  adapter.__phStartupGate535Installed = true;
  adapter.__phStartupGate535Ready = false;
  adapter.__phStartupGate535Logged = false;

  async function ensureDebugObject() {
    await adapter.setObjectNotExistsAsync(DEBUG_ID, {
      type: 'state',
      common: {
        name: 'pH Startschutz 0.5.35',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: ''
      },
      native: {}
    });
  }

  async function readRaw() {
    try {
      const state = await adapter.getForeignStateAsync(RAW_ID);
      return num(state && state.val);
    } catch {
      return null;
    }
  }

  async function checkReady(reason = 'check') {
    await ensureDebugObject().catch(() => {});

    const raw = await readRaw();
    const authoritative = num(adapter.__phAuthoritative534);
    const ready = plausiblePoolPh(raw) && plausiblePoolPh(authoritative);

    adapter.__phStartupGate535Ready = ready;

    if (ready) {
      adapter.__phStartupGate535Logged = false;
      await adapter.setStateIfChanged(
        DEBUG_ID,
        `FREIGEGEBEN · ${reason} · PH803W roh ${raw.toFixed(3)} · autoritativ ${authoritative.toFixed(3)}`,
        true
      ).catch(() => {});
      return true;
    }

    await adapter.setStateIfChanged(
      DEBUG_ID,
      `GESPERRT · ${reason} · PH803W roh ${raw === null ? '--' : raw} · autoritativ ${authoritative === null ? '--' : authoritative}`,
      true
    ).catch(() => {});

    return false;
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const authoritative = num(adapter.__phAuthoritative534);
      const ready = adapter.__phStartupGate535Ready && plausiblePoolPh(authoritative);
      const next = {
        ...(data || {}),
        adapterVersion: VERSION,
        ph: ready ? authoritative : null,
        phInRange: ready ? (authoritative >= 7.0 && authoritative <= 7.4) : false
      };
      return patchVersion(original(next));
    };
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRenderVisFull = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullWithStartupGate(...args) {
      const result = await originalRenderVisFull(...args);
      const ready = await checkReady('nach VIS-Synchronisation');
      if (ready) return result;

      if (!adapter.__phStartupGate535Logged && adapter.log) {
        adapter.__phStartupGate535Logged = true;
        adapter.log.error('[PH-STARTSCHUTZ 0.5.35] VIS bleibt gesperrt, bis PH803W und der autoritative pH-Wert plausibel verfügbar sind.');
      }
      return result;
    };
  }

  if (typeof adapter.applyControlLogic === 'function') {
    const originalApplyControlLogic = adapter.applyControlLogic.bind(adapter);
    adapter.applyControlLogic = async function applyControlLogicWithStartupGate(...args) {
      const raw = await readRaw();
      if (!plausiblePoolPh(raw)) {
        adapter.__phStartupGate535Ready = false;
        await ensureDebugObject().catch(() => {});
        await adapter.setStateIfChanged(
          DEBUG_ID,
          `GESPERRT · vor Regelzyklus · PH803W roh ${raw === null ? '--' : raw}`,
          true
        ).catch(() => {});

        if (!adapter.__phStartupGate535Logged && adapter.log) {
          adapter.__phStartupGate535Logged = true;
          adapter.log.error('[PH-STARTSCHUTZ 0.5.35] pH-Regelung übersprungen: PH803W-Rohwert beim Start noch nicht plausibel verfügbar.');
        }
        return;
      }

      const result = await originalApplyControlLogic(...args);
      await checkReady('nach Regel-Synchronisation');
      return result;
    };
  }

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown || id !== RAW_ID) return;
    if (!plausiblePoolPh(state.val)) {
      adapter.__phStartupGate535Ready = false;
      return;
    }

    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;

      const ready = await checkReady('PH803W State-Aenderung');
      if (!ready) return;

      try {
        if (typeof adapter.renderVisFull === 'function') {
          await adapter.renderVisFull();
        }
      } catch (error) {
        if (adapter.log) {
          adapter.log.error(`[PH-STARTSCHUTZ 0.5.35] VIS-Neurender nach Sensorfreigabe fehlgeschlagen: ${error && error.message ? error.message : error}`);
        }
      }
    }, 500));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

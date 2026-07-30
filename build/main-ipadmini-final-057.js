'use strict';

const createBase = require('./main-ipadmini-final-056.js');

const VERSION = 'v0.4.57';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const POINTS_ID = 'status.phCalibration.pointsJson';
const POLL_MS = 3000;
const FALLBACK_DELTA = -0.21;
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function rnd(value, digits = 3) {
  return Math.round(Number(value) * (10 ** digits)) / (10 ** digits);
}

function normalizePoints(value) {
  const source = Array.isArray(value) ? value : [];
  return source.map(point => {
    const raw = num(point && point.raw);
    const ref = num(point && (point.ref !== undefined ? point.ref : point.poollab));
    if (raw === null || ref === null || raw < 0 || raw > 14 || ref < 0 || ref > 14) return null;
    return {
      raw: rnd(raw),
      ref: rnd(ref),
      delta: rnd(ref - raw),
      ts: Number(point.ts) || 0
    };
  }).filter(Boolean).sort((a, b) => a.raw - b.raw);
}

function calculate(rawValue, pointsValue) {
  const raw = num(rawValue);
  const points = normalizePoints(pointsValue);
  if (raw === null) return null;
  if (!points.length) return rnd(raw + FALLBACK_DELTA);
  if (points.length === 1) return rnd(raw + points[0].delta);
  if (raw <= points[0].raw) return rnd(raw + points[0].delta);
  const last = points[points.length - 1];
  if (raw >= last.raw) return rnd(raw + last.delta);

  for (let index = 1; index < points.length; index++) {
    const right = points[index];
    if (raw > right.raw) continue;
    const left = points[index - 1];
    const factor = (raw - left.raw) / Math.max(0.000001, right.raw - left.raw);
    return rnd(raw + left.delta + ((right.delta - left.delta) * factor));
  }
  return rnd(raw + last.delta);
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

async function loadPoints(adapter) {
  try {
    const state = await adapter.getStateAsync(POINTS_ID);
    const parsed = JSON.parse(String((state && state.val) || '[]'));
    return normalizePoints(parsed);
  } catch {
    return [];
  }
}

async function ensureStatusStates(adapter) {
  await adapter.ensureState('status.phCalibration.pollRaw', 'number', 'value.ph', 0, false);
  await adapter.ensureState('status.phCalibration.pollCorrected', 'number', 'value.ph', 0, false);
  await adapter.ensureState('status.phCalibration.rawAgeSec', 'number', 'value.interval', 0, false);
  await adapter.ensureState('status.phCalibration.lastPollTs', 'number', 'value.time', 0, false);
}

async function harmonizeVersions(adapter) {
  for (const id of VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch {}
  }
}

function install(adapter) {
  if (!adapter || adapter.__phPolling057Installed) return adapter;
  adapter.__phPolling057Installed = true;
  adapter.__phPolling057Timer = null;
  adapter.__phPolling057Running = false;
  adapter.__phPolling057LastRaw = null;
  adapter.__phPolling057LastCorrected = null;

  async function poll(reason = 'Intervall') {
    if (adapter.isShuttingDown || adapter.__phPolling057Running) return;
    adapter.__phPolling057Running = true;
    try {
      const [rawState, outputState, points] = await Promise.all([
        adapter.getForeignStateAsync(RAW_ID),
        adapter.getForeignStateAsync(OUT_ID),
        loadPoints(adapter)
      ]);

      const raw = num(rawState && rawState.val);
      if (raw === null) {
        await adapter.setStateIfChanged('status.phCalibration.lastMessage', 'PH803-Rohwert ist nicht verfügbar.', true);
        return;
      }

      const corrected = calculate(raw, points);
      const currentOutput = num(outputState && outputState.val);
      const rawAgeSec = rawState && rawState.ts
        ? Math.max(0, Math.round((Date.now() - Number(rawState.ts)) / 1000))
        : 0;

      await adapter.setStateIfChanged('status.phCalibration.pollRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.pollCorrected', corrected, true);
      await adapter.setStateIfChanged('status.phCalibration.rawAgeSec', rawAgeSec, true);
      await adapter.setStateIfChanged('status.phCalibration.lastPollTs', Date.now(), true);
      await adapter.setStateIfChanged('status.phCalibration.currentRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.currentCorrected', corrected, true);
      await adapter.setStateIfChanged('status.phCalibration.currentDelta', rnd(corrected - raw), true);

      const outputWrong = currentOutput === null || Math.abs(currentOutput - corrected) > 0.0005;
      const rawChanged = adapter.__phPolling057LastRaw === null || Math.abs(adapter.__phPolling057LastRaw - raw) > 0.0005;
      const correctedChanged = adapter.__phPolling057LastCorrected === null || Math.abs(adapter.__phPolling057LastCorrected - corrected) > 0.0005;

      if (outputWrong) {
        await adapter.setForeignStateAsync(OUT_ID, corrected, true);
        if (adapter.config.debugMode && adapter.log && typeof adapter.log.debug === 'function') {
          adapter.log.debug(`[PH-KAL] ${reason}: PH803 ${raw.toFixed(3)} -> korrigiert ${corrected.toFixed(3)} (value_korr repariert)`);
        }
      }

      adapter.__phPolling057LastRaw = raw;
      adapter.__phPolling057LastCorrected = corrected;

      if (rawChanged || correctedChanged || outputWrong) {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (Object.prototype.hasOwnProperty.call(adapter, '__ipadLastFullRender056')) {
          adapter.__ipadLastFullRender056 = 0;
        }
        try { adapter.queueRender(); } catch {}
      }
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[PH-KAL] Zyklische Korrektur fehlgeschlagen: ' + (error.message || error));
      }
    } finally {
      adapter.__phPolling057Running = false;
    }
  }

  function scheduleNext() {
    if (adapter.isShuttingDown) return;
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      adapter.__phPolling057Timer = null;
      await poll('3-Sekunden-Prüfung');
      scheduleNext();
    }, POLL_MS));
    adapter.__phPolling057Timer = handle;
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
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await ensureStatusStates(adapter);
        try { adapter.subscribeForeignStates(RAW_ID); } catch {}
        await poll('Adapterstart');
        scheduleNext();
        if (adapter.log && typeof adapter.log.info === 'function') {
          adapter.log.info(`[PH-KAL] ${VERSION}: PH803-Rohwert wird alle ${POLL_MS / 1000}s geprüft`);
        }
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
          adapter.log.warn('[PH-KAL] Polling-Start fehlgeschlagen: ' + (error.message || error));
        }
      }
    }, 6500));
  });

  adapter.on('stateChange', (id, state) => {
    if (id !== RAW_ID || !state || adapter.isShuttingDown) return;
    poll('PH803-Ereignis').catch(() => {});
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

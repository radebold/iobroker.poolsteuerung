'use strict';

const createBase = require('./main-ipadmini-final-066.js');

const VERSION = 'v0.4.67';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const POINTS_ID = 'status.phCalibration.pointsJson';
const HISTORY_ID = 'status.phCalibration.pointsHistoryJson';
const ACTIVE_ID = 'status.phCalibration.activePointJson';
const MODE_ID = 'status.phCalibration.calculationMode';
const POOLLAB_ID = 'control.ph.calibration.poollabValue';
const SAVE_TRIGGER_ID = 'control.ph.calibration.saveTrigger';
const CAPTURE_ID = 'control.ph.calibration.captureRequest';
const RESULT_ID = 'status.phCalibration.captureResult';
const LAST_REQUEST_ID = 'status.phCalibration.lastCaptureRequestId';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];
const LOOP_MS = 750;
const MAX_RAW_AGE_MS = 10 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function rnd(value, digits = 3) {
  return Math.round(Number(value) * (10 ** digits)) / (10 ** digits);
}

function fmt(value) {
  const parsed = num(value);
  return parsed === null ? '--' : parsed.toFixed(2).replace('.', ',');
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function normalizePoint(point) {
  const raw = num(point && point.raw);
  const ref = num(point && (point.ref !== undefined ? point.ref : point.poollab));
  if (raw === null || ref === null || raw < 0 || raw > 14 || ref < 0 || ref > 14) return null;
  const ts = Number(point && point.ts);
  return {
    raw: rnd(raw),
    ref: rnd(ref),
    delta: rnd(ref - raw),
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now()
  };
}

function normalizePoints(value) {
  const source = Array.isArray(value) ? value : [];
  return source.map(normalizePoint).filter(Boolean).sort((a, b) => a.ts - b.ts);
}

function parseJsonPoints(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
    return normalizePoints(parsed);
  } catch {
    return [];
  }
}

function latestPoint(pointsValue) {
  const points = normalizePoints(pointsValue);
  return points.length ? points[points.length - 1] : null;
}

function samePoint(a, b) {
  return !!a && !!b &&
    Math.abs(a.raw - b.raw) <= 0.0005 &&
    Math.abs(a.ref - b.ref) <= 0.0005 &&
    Math.abs(a.delta - b.delta) <= 0.0005 &&
    Number(a.ts) === Number(b.ts);
}

function mergeHistory(...collections) {
  const merged = [];
  for (const collection of collections) {
    for (const point of normalizePoints(collection)) {
      const duplicate = merged.find(existing =>
        Math.abs(existing.raw - point.raw) <= 0.005 &&
        Math.abs(existing.ref - point.ref) <= 0.005 &&
        Math.abs(existing.ts - point.ts) <= DUPLICATE_WINDOW_MS
      );
      if (duplicate) {
        if (point.ts >= duplicate.ts) Object.assign(duplicate, point);
      } else {
        merged.push({ ...point });
      }
    }
  }
  return merged.sort((a, b) => a.ts - b.ts).slice(-100);
}

function calculateWithLatest(rawValue, pointsValue) {
  const raw = num(rawValue);
  const active = latestPoint(pointsValue);
  if (raw === null || !active) return null;
  return rnd(raw + active.delta);
}

function parseCaptureRequest(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    if (!parsed || typeof parsed !== 'object') return null;
    const poollab = num(parsed.poollab);
    const ts = Number(parsed.ts);
    const nonce = String(parsed.nonce || '');
    if (poollab === null || poollab < 0 || poollab > 14 || !Number.isFinite(ts) || ts <= 0 || !nonce) return null;
    return { poollab, ts, nonce, id: `${ts}:${nonce}` };
  } catch {
    return null;
  }
}

async function readJsonState(adapter, id, fallback = []) {
  try {
    const state = await adapter.getStateAsync(id);
    const parsed = JSON.parse(String((state && state.val) || JSON.stringify(fallback)));
    return parsed;
  } catch {
    return fallback;
  }
}

function install(adapter) {
  if (!adapter || adapter.__latestOffset067Installed) return adapter;
  adapter.__latestOffset067Installed = true;
  adapter.__latestOffset067Busy = false;
  adapter.__latestOffset067LastSaveTrigger = null;
  adapter.__latestOffset067LastCaptureText = '';
  adapter.__latestOffset067LastPointsText = '';
  adapter.__latestOffset067RenderTimer = null;

  async function ensureStates() {
    await adapter.ensureState(HISTORY_ID, 'string', 'json', '[]', false);
    await adapter.ensureState(ACTIVE_ID, 'string', 'json', '{}', false);
    await adapter.ensureState(MODE_ID, 'string', 'text', 'latest-offset', false);
    await adapter.setStateIfChanged(MODE_ID, 'latest-offset', true);
  }

  async function readRaw() {
    const state = await adapter.getForeignStateAsync(RAW_ID);
    const raw = num(state && state.val);
    const ts = Number(state && (state.ts || state.lc)) || 0;
    return {
      raw,
      ageMs: ts ? Math.max(0, Date.now() - ts) : 0,
      state
    };
  }

  function requestRender() {
    if (adapter.__latestOffset067RenderTimer) return;
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      adapter.__latestOffset067RenderTimer = null;
      if (adapter.isShuttingDown) return;
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      if (Object.prototype.hasOwnProperty.call(adapter, '__ipadLastFullRender056')) adapter.__ipadLastFullRender056 = 0;
      try { await adapter.forceImmediateRender(); } catch {}
    }, 180));
    adapter.__latestOffset067RenderTimer = handle;
  }

  async function persistLatest(historyValue, activeValue, reason, requestId = '') {
    const history = normalizePoints(historyValue);
    const active = normalizePoint(activeValue);
    if (!active) throw new Error('Kein gültiger letzter Kalibrierpunkt vorhanden');
    if (Math.abs(active.delta) > 0.60) throw new Error(`Unplausibles Kalibrierdelta ${active.delta.toFixed(3)}`);

    const activeText = JSON.stringify([active]);
    const historyText = JSON.stringify(history);
    adapter.__latestOffset067LastPointsText = activeText;

    await adapter.setStateIfChanged(HISTORY_ID, historyText, true);
    await adapter.setStateIfChanged(ACTIVE_ID, JSON.stringify(active), true);
    await adapter.setStateIfChanged(POINTS_ID, activeText, true);
    await adapter.setStateIfChanged('status.phCalibration.count', history.length, true);
    await adapter.setStateIfChanged('status.phCalibration.lastPoollab', active.ref, true);
    await adapter.setStateIfChanged('status.phCalibration.lastRaw', active.raw, true);
    await adapter.setStateIfChanged('status.phCalibration.lastSavedTs', active.ts, true);
    await adapter.setStateIfChanged('status.phCalibration.initialized', true, true);
    await adapter.setStateIfChanged(MODE_ID, 'latest-offset', true);
    if (requestId) await adapter.setStateIfChanged(LAST_REQUEST_ID, requestId, true);

    const rawInfo = await readRaw();
    if (rawInfo.raw === null) throw new Error('PH803-Rohwert ist nicht verfügbar');
    if (rawInfo.ageMs > MAX_RAW_AGE_MS) throw new Error(`PH803-Rohwert ist ${Math.round(rawInfo.ageMs / 60000)} Minuten alt`);

    const corrected = calculateWithLatest(rawInfo.raw, [active]);
    if (corrected === null) throw new Error('Korrigierter pH konnte nicht berechnet werden');

    await adapter.setForeignStateAsync(OUT_ID, corrected, true);
    await adapter.setStateIfChanged('status.phCalibration.currentRaw', rnd(rawInfo.raw), true);
    await adapter.setStateIfChanged('status.phCalibration.currentCorrected', corrected, true);
    await adapter.setStateIfChanged('status.phCalibration.currentDelta', active.delta, true);

    adapter.__phCalibrationPoints = [active];
    adapter.__phCentral059Raw = rawInfo.raw;
    adapter.__phCentral059Corrected = corrected;
    adapter.__phCentral059LastDisplayWrite = 0;
    adapter.__phPolling057LastRaw = null;
    adapter.__phPolling057LastCorrected = null;

    const message = `${reason}: letzter PoolLab-Punkt ${fmt(active.raw)} → ${fmt(active.ref)}; aktiver Offset ${active.delta >= 0 ? '+' : ''}${fmt(active.delta)}; aktuell ${fmt(rawInfo.raw)} → ${fmt(corrected)}.`;
    await adapter.setStateIfChanged('status.phCalibration.lastMessage', message, true);
    await adapter.setStateIfChanged(RESULT_ID, message, true);
    requestRender();
    return { active, history, raw: rawInfo.raw, corrected, message };
  }

  async function enforceStoredPoints(reason = 'Kalibrierung synchronisiert') {
    const [pointsState, historyStored] = await Promise.all([
      adapter.getStateAsync(POINTS_ID),
      readJsonState(adapter, HISTORY_ID, [])
    ]);
    const pointsText = String((pointsState && pointsState.val) || '[]');
    const points = parseJsonPoints(pointsText);
    const history = mergeHistory(historyStored, points);
    const active = latestPoint(history);
    if (!active) return null;

    const expected = JSON.stringify([active]);
    const activeState = await adapter.getStateAsync(ACTIVE_ID);
    const currentActive = normalizePoint((() => {
      try { return JSON.parse(String((activeState && activeState.val) || '{}')); }
      catch { return null; }
    })());

    const needsPersist = pointsText !== expected || !samePoint(currentActive, active) || history.length !== normalizePoints(historyStored).length;
    if (needsPersist) return persistLatest(history, active, reason);

    const rawInfo = await readRaw();
    if (rawInfo.raw === null || rawInfo.ageMs > MAX_RAW_AGE_MS) return null;
    const corrected = calculateWithLatest(rawInfo.raw, [active]);
    const outState = await adapter.getForeignStateAsync(OUT_ID);
    const currentOut = num(outState && outState.val);
    if (corrected !== null && (currentOut === null || Math.abs(currentOut - corrected) > 0.0005)) {
      return persistLatest(history, active, 'Korrekturwert mit letztem Offset repariert');
    }
    return { active, history, raw: rawInfo.raw, corrected };
  }

  async function saveMeasurement(poollabValue, tsValue, source, requestId = '') {
    const poollab = num(poollabValue);
    if (poollab === null || poollab < 0 || poollab > 14) throw new Error(`Ungültiger PoolLab-Wert: ${poollabValue}`);

    const rawInfo = await readRaw();
    if (rawInfo.raw === null || rawInfo.raw < 0 || rawInfo.raw > 14) throw new Error('PH803-Rohwert ist nicht verfügbar oder ungültig');
    if (rawInfo.ageMs > MAX_RAW_AGE_MS) throw new Error(`PH803-Rohwert ist ${Math.round(rawInfo.ageMs / 60000)} Minuten alt`);

    const ts = Number(tsValue) > 0 ? Number(tsValue) : Date.now();
    const point = normalizePoint({ raw: rawInfo.raw, ref: poollab, ts });
    if (!point) throw new Error('Kalibrierpunkt konnte nicht erzeugt werden');

    const [historyStored, pointsState] = await Promise.all([
      readJsonState(adapter, HISTORY_ID, []),
      adapter.getStateAsync(POINTS_ID)
    ]);
    const points = parseJsonPoints(String((pointsState && pointsState.val) || '[]'));
    let history = mergeHistory(historyStored, points);

    const duplicate = history.find(existing =>
      Math.abs(existing.raw - point.raw) <= 0.005 &&
      Math.abs(existing.ref - point.ref) <= 0.005 &&
      Math.abs(existing.ts - point.ts) <= DUPLICATE_WINDOW_MS
    );
    if (duplicate) Object.assign(duplicate, point);
    else history.push(point);
    history = normalizePoints(history).slice(-100);

    await adapter.setStateIfChanged(POOLLAB_ID, poollab, true);
    const result = await persistLatest(history, point, `${source} gespeichert`, requestId);
    if (adapter.log && typeof adapter.log.info === 'function') adapter.log.info(`[PH-KAL] ${VERSION}: ${result.message}`);
    return result;
  }

  async function processInputs() {
    const [saveState, poollabState, captureState] = await Promise.all([
      adapter.getStateAsync(SAVE_TRIGGER_ID),
      adapter.getStateAsync(POOLLAB_ID),
      adapter.getStateAsync(CAPTURE_ID)
    ]);

    const saveTrigger = Number(saveState && saveState.val);
    if (Number.isFinite(saveTrigger) && saveTrigger > 0 && saveTrigger !== adapter.__latestOffset067LastSaveTrigger) {
      adapter.__latestOffset067LastSaveTrigger = saveTrigger;
      await saveMeasurement(poollabState && poollabState.val, saveTrigger, 'PoolLab-Erfassung', `save:${saveTrigger}`);
    }

    const captureText = String((captureState && captureState.val) || '');
    if (captureText && captureText !== adapter.__latestOffset067LastCaptureText) {
      adapter.__latestOffset067LastCaptureText = captureText;
      const request = parseCaptureRequest(captureText);
      if (request) await saveMeasurement(request.poollab, request.ts, 'PoolLab-Auftrag', request.id);
    }
  }

  async function cycle() {
    if (adapter.isShuttingDown || adapter.__latestOffset067Busy) return;
    adapter.__latestOffset067Busy = true;
    try {
      await processInputs();
      await enforceStoredPoints('Neuester Kalibrierpunkt aktiviert');
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      await adapter.setStateIfChanged(RESULT_ID, `Kalibrierung fehlgeschlagen: ${text}`, true);
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', `Kalibrierung fehlgeschlagen: ${text}`, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', true, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', `Kalibrierung fehlgeschlagen: ${text}`, true);
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[PH-KAL] ${VERSION}: ${text}`);
      }
    } finally {
      adapter.__latestOffset067Busy = false;
    }
  }

  function scheduleCycle(delay = LOOP_MS) {
    if (adapter.isShuttingDown) return;
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      await cycle();
      scheduleCycle(LOOP_MS);
    }, delay));
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const patched = { ...(data || {}), adapterVersion: VERSION };
      if (adapter.__phCentral059Corrected !== null && adapter.__phCentral059Corrected !== undefined) {
        patched.ph = adapter.__phCentral059Corrected;
      }
      return patchVersion(original(patched));
    };
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      for (const id of VIS_STATES) {
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
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await ensureStates();
        const [saveState, captureState] = await Promise.all([
          adapter.getStateAsync(SAVE_TRIGGER_ID),
          adapter.getStateAsync(CAPTURE_ID)
        ]);
        adapter.__latestOffset067LastSaveTrigger = Number(saveState && saveState.val) || 0;
        adapter.__latestOffset067LastCaptureText = String((captureState && captureState.val) || '');

        await enforceStoredPoints('Umstellung auf letzten Kalibrierpunkt');
        scheduleCycle(LOOP_MS);
        if (adapter.log && typeof adapter.log.info === 'function') {
          adapter.log.info(`[PH-KAL] ${VERSION}: letzter zeitlicher Kalibrierpunkt ist alleiniger aktiver Offset; Historie in ${adapter.namespace}.${HISTORY_ID}`);
        }
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
          adapter.log.error(`[PH-KAL] ${VERSION} Start fehlgeschlagen: ${error.message || error}`);
        }
      }
    }, 500));
  });

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown) return;
    if (id === RAW_ID || id === `${adapter.namespace}.${POINTS_ID}` || id === `${adapter.namespace}.${SAVE_TRIGGER_ID}` || id === `${adapter.namespace}.${CAPTURE_ID}`) {
      cycle().catch(() => {});
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

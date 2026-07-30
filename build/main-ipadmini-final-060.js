'use strict';

const createBase = require('./main-ipadmini-final-059.js');

const VERSION = 'v0.4.60';
const POOLLAB_ID = 'control.ph.calibration.poollabValue';
const SAVE_TRIGGER_ID = 'control.ph.calibration.saveTrigger';
const POINTS_ID = 'status.phCalibration.pointsJson';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

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
      ts: Number(point.ts) || Date.now()
    };
  }).filter(Boolean).sort((a, b) => a.raw - b.raw);
}

function addPoint(pointsValue, rawValue, refValue) {
  const points = normalizePoints(pointsValue);
  const raw = rnd(rawValue);
  const ref = rnd(refValue);
  const next = { raw, ref, delta: rnd(ref - raw), ts: Date.now() };
  const index = points.findIndex(point => Math.abs(point.raw - raw) <= 0.02);
  if (index >= 0) points[index] = next;
  else points.push(next);
  return normalizePoints(points).sort((a, b) => a.raw - b.raw).slice(-40);
}

function calculate(rawValue, pointsValue) {
  const raw = num(rawValue);
  const points = normalizePoints(pointsValue);
  if (raw === null || !points.length) return null;
  if (points.length === 1) return rnd(raw + points[0].delta);
  if (raw <= points[0].raw) return rnd(raw + points[0].delta);
  const last = points[points.length - 1];
  if (raw >= last.raw) return rnd(raw + last.delta);
  for (let index = 1; index < points.length; index++) {
    const right = points[index];
    if (raw > right.raw) continue;
    const left = points[index - 1];
    const factor = (raw - left.raw) / Math.max(0.000001, right.raw - left.raw);
    const delta = left.delta + ((right.delta - left.delta) * factor);
    return rnd(raw + delta);
  }
  return rnd(raw + last.delta);
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

async function readPoints(adapter) {
  try {
    const state = await adapter.getStateAsync(POINTS_ID);
    return normalizePoints(JSON.parse(String((state && state.val) || '[]')));
  } catch {
    return [];
  }
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
  if (!adapter || adapter.__phDirectCapture060Installed) return adapter;
  adapter.__phDirectCapture060Installed = true;
  adapter.__phDirectCapture060Running = false;

  async function capturePoolLab(poollabValue) {
    if (adapter.__phDirectCapture060Running || adapter.isShuttingDown) return;
    adapter.__phDirectCapture060Running = true;
    try {
      const poollab = num(poollabValue);
      if (poollab === null || poollab < 0 || poollab > 14) {
        throw new Error(`Ungültiger PoolLab-Wert: ${poollabValue}`);
      }

      const rawState = await adapter.getForeignStateAsync(RAW_ID);
      const raw = num(rawState && rawState.val);
      if (raw === null || raw < 0 || raw > 14) {
        throw new Error('PH803-Rohwert ist nicht verfügbar oder ungültig');
      }

      const existing = await readPoints(adapter);
      const replaced = existing.some(point => Math.abs(point.raw - raw) <= 0.02);
      const points = addPoint(existing, raw, poollab);
      const corrected = calculate(raw, points);
      if (corrected === null) throw new Error('Korrigierter pH konnte nicht berechnet werden');

      adapter.__phExplicitSaveAt = Date.now();
      if (adapter.__phAutoSaveTimer) {
        try { clearTimeout(adapter.__phAutoSaveTimer); } catch {}
        adapter.__phAutoSaveTimer = null;
      }

      await adapter.setStateAsync(POOLLAB_ID, poollab, true);
      await adapter.setStateAsync(SAVE_TRIGGER_ID, Date.now(), true);
      await adapter.setStateIfChanged(POINTS_ID, JSON.stringify(points), true);
      await adapter.setStateIfChanged('status.phCalibration.count', points.length, true);
      await adapter.setStateIfChanged('status.phCalibration.lastPoollab', rnd(poollab), true);
      await adapter.setStateIfChanged('status.phCalibration.lastRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.lastSavedTs', Date.now(), true);
      await adapter.setStateIfChanged('status.phCalibration.currentRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.currentCorrected', corrected, true);
      await adapter.setStateIfChanged('status.phCalibration.currentDelta', rnd(corrected - raw), true);
      await adapter.setForeignStateAsync(OUT_ID, corrected, true);

      adapter.__phCalibrationPoints = points;
      adapter.__phCentral059Raw = raw;
      adapter.__phCentral059Corrected = corrected;
      adapter.__phCentral059LastDisplayWrite = 0;
      adapter.__phPolling057LastRaw = null;
      adapter.__phPolling057LastCorrected = null;

      const delta = rnd(poollab - raw);
      const message = `${replaced ? 'Kalibrierpunkt aktualisiert' : 'Kalibrierpunkt gespeichert'}: PH803 ${fmt(raw)} → PoolLab ${fmt(poollab)} (${delta >= 0 ? '+' : ''}${fmt(delta)}).`;
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', message, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', false, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', '', true);

      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      if (Object.prototype.hasOwnProperty.call(adapter, '__ipadLastFullRender056')) adapter.__ipadLastFullRender056 = 0;
      try { await adapter.forceImmediateRender(); } catch {}

      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info(`[PH-KAL] ${VERSION}: ${message}`);
      }
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', `Kalibrierung fehlgeschlagen: ${text}`, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', true, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', `Kalibrierung fehlgeschlagen: ${text}`, true);
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
        adapter.log.error('[PH-KAL] Direkte PoolLab-Erfassung fehlgeschlagen: ' + text);
      }
    } finally {
      adapter.__phDirectCapture060Running = false;
    }
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
    try { adapter.subscribeStates(POOLLAB_ID); } catch {}
  });

  adapter.on('stateChange', (id, state) => {
    if (id !== `${adapter.namespace}.${POOLLAB_ID}` || !state || state.ack === true || adapter.isShuttingDown) return;
    capturePoolLab(state.val).catch(() => {});
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

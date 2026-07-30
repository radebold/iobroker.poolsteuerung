'use strict';

const createBase = require('./main-ipadmini-final-058.js');

const VERSION = 'v0.4.59';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const POINTS_ID = 'status.phCalibration.pointsJson';
const IPAD_STATE = 'vis.htmlIpadMini';
const EDIT_STATE = 'control.ph.calibration.ipadMiniEditing';
const CHECK_MS = 3000;
const DISPLAY_INTERVAL_MS = 20000;

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function rnd(value, digits = 3) {
  return Math.round(Number(value) * (10 ** digits)) / (10 ** digits);
}

function formatPh(value) {
  const parsed = num(value);
  return parsed === null ? '--' : parsed.toFixed(2).replace('.', ',');
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'ja', 'yes', 'active', 'aktiv'].includes(String(value ?? '').trim().toLowerCase());
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
    const interpolatedDelta = left.delta + ((right.delta - left.delta) * factor);
    return rnd(raw + interpolatedDelta);
  }
  return rnd(raw + last.delta);
}

function validatePoints(pointsValue) {
  const points = normalizePoints(pointsValue);
  if (!points.length) return { ok: false, reason: 'Kein gültiger PoolLab-Kalibrierpunkt vorhanden', points };

  for (const point of points) {
    if (Math.abs(point.delta) > 0.60) {
      return { ok: false, reason: `Unplausibles Kalibrierdelta ${point.delta.toFixed(3)}`, points };
    }
  }

  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1];
    const right = points[index];
    const rawGap = right.raw - left.raw;
    if (rawGap < 0.05) continue;
    const slope = (right.ref - left.ref) / rawGap;
    if (slope < 0.35 || slope > 1.65) {
      return { ok: false, reason: `Unplausible Kalibrierkennlinie zwischen ${left.raw.toFixed(2)} und ${right.raw.toFixed(2)}`, points };
    }
  }

  return { ok: true, reason: '', points };
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function patchIpadPh(htmlValue, corrected, raw) {
  let html = patchVersion(htmlValue);
  const label = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = html.indexOf(label);
  if (labelIndex < 0) return html;
  const readingIndex = html.indexOf('<div class="metric-reading', labelIndex);
  const sectionEnd = html.indexOf('</section>', readingIndex);
  if (readingIndex < 0 || sectionEnd < 0) return html;

  const before = html.slice(0, readingIndex);
  let section = html.slice(readingIndex, sectionEnd);
  section = section.replace(/<span class="metric-value">[^<]*<\/span>/, `<span class="metric-value">${formatPh(corrected)}</span>`);
  if (section.includes('data-ph-raw="1"')) {
    section = section.replace(/<span class="ph-raw" data-ph-raw="1">\([^<]*\)<\/span>/, `<span class="ph-raw" data-ph-raw="1">(${formatPh(raw)})</span>`);
  }
  return before + section + html.slice(sectionEnd);
}

async function readPoints(adapter) {
  try {
    const state = await adapter.getStateAsync(POINTS_ID);
    return normalizePoints(JSON.parse(String((state && state.val) || '[]')));
  } catch {
    return [];
  }
}

async function setSafetyState(adapter, blocked, reason) {
  await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', !!blocked, true);
  await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', String(reason || ''), true);
}

function install(adapter) {
  if (!adapter || adapter.__phCentral059Installed) return adapter;
  adapter.__phCentral059Installed = true;
  adapter.__phCentral059Running = false;
  adapter.__phCentral059Timer = null;
  adapter.__phCentral059Corrected = null;
  adapter.__phCentral059Raw = null;
  adapter.__phCentral059LastDisplayWrite = 0;

  async function evaluate(reason = 'Prüfung') {
    const [rawState, outputState, points] = await Promise.all([
      adapter.getForeignStateAsync(RAW_ID),
      adapter.getForeignStateAsync(OUT_ID),
      readPoints(adapter)
    ]);

    const raw = num(rawState && rawState.val);
    const validation = validatePoints(points);
    if (raw === null) return { ok: false, reason: 'PH803-Rohwert nicht verfügbar', raw: null, corrected: null, points };
    if (!validation.ok) return { ok: false, reason: validation.reason, raw, corrected: null, points };

    const ageMs = rawState && (rawState.ts || rawState.lc)
      ? Math.max(0, Date.now() - Number(rawState.ts || rawState.lc))
      : 0;
    if (ageMs > 10 * 60 * 1000) {
      return { ok: false, reason: `PH803-Rohwert ist ${Math.round(ageMs / 60000)} Minuten alt`, raw, corrected: null, points };
    }

    const corrected = calculate(raw, points);
    if (corrected === null) return { ok: false, reason: 'Korrigierter pH konnte nicht berechnet werden', raw, corrected: null, points };

    const output = num(outputState && outputState.val);
    if (output === null || Math.abs(output - corrected) > 0.0005) {
      await adapter.setForeignStateAsync(OUT_ID, corrected, true);
      if (adapter.config.debugMode && adapter.log && typeof adapter.log.debug === 'function') {
        adapter.log.debug(`[PH-KAL] ${reason}: ${raw.toFixed(3)} + Delta = ${corrected.toFixed(3)}`);
      }
    }

    return { ok: true, reason: '', raw, corrected, points, ageMs };
  }

  async function patchIpadDisplay(force = false) {
    if (adapter.__phCentral059Corrected === null || adapter.__phCentral059Raw === null) return;
    try {
      const editingState = await adapter.getStateAsync(EDIT_STATE);
      if (boolValue(editingState && editingState.val)) return;
      if (!force && Date.now() - adapter.__phCentral059LastDisplayWrite < DISPLAY_INTERVAL_MS) return;
      const state = await adapter.getStateAsync(IPAD_STATE);
      const current = String((state && state.val) || '');
      const next = patchIpadPh(current, adapter.__phCentral059Corrected, adapter.__phCentral059Raw);
      if (next && next !== current) await adapter.setStateIfChanged(IPAD_STATE, next, true);
      adapter.__phCentral059LastDisplayWrite = Date.now();
    } catch {}
  }

  async function synchronize(reason = 'Intervall', forceDisplay = false) {
    if (adapter.isShuttingDown || adapter.__phCentral059Running) return null;
    adapter.__phCentral059Running = true;
    try {
      const previousRaw = adapter.__phCentral059Raw;
      const previousCorrected = adapter.__phCentral059Corrected;
      const result = await evaluate(reason);

      if (!result.ok) {
        await setSafetyState(adapter, true, result.reason);
        return result;
      }

      adapter.__phCentral059Raw = result.raw;
      adapter.__phCentral059Corrected = result.corrected;
      await adapter.setStateIfChanged('status.phCalibration.currentRaw', rnd(result.raw), true);
      await adapter.setStateIfChanged('status.phCalibration.currentCorrected', result.corrected, true);
      await adapter.setStateIfChanged('status.phCalibration.currentDelta', rnd(result.corrected - result.raw), true);

      const changed = previousRaw === null || previousCorrected === null ||
        Math.abs(previousRaw - result.raw) > 0.0005 ||
        Math.abs(previousCorrected - result.corrected) > 0.0005;

      if (changed) {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        try { adapter.queueRender(); } catch {}
      }
      await patchIpadDisplay(forceDisplay || changed);
      return result;
    } catch (error) {
      const reasonText = error && error.message ? error.message : String(error);
      await setSafetyState(adapter, true, `pH-Prüfung fehlgeschlagen: ${reasonText}`);
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[PH-KAL] Zentrale pH-Prüfung fehlgeschlagen: ' + reasonText);
      }
      return { ok: false, reason: reasonText };
    } finally {
      adapter.__phCentral059Running = false;
    }
  }

  function scheduleNext() {
    if (adapter.isShuttingDown) return;
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      adapter.__phCentral059Timer = null;
      await synchronize('3-Sekunden-Prüfung', false);
      scheduleNext();
    }, CHECK_MS));
    adapter.__phCentral059Timer = handle;
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const patched = { ...(data || {}), adapterVersion: VERSION };
      if (adapter.__phCentral059Corrected !== null) patched.ph = adapter.__phCentral059Corrected;
      return patchVersion(original(patched));
    };
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchIpadDisplay(false);
      return result;
    };
  }

  if (typeof adapter.runDosePumpOnce === 'function') {
    const originalDose = adapter.runDosePumpOnce.bind(adapter);
    adapter.runDosePumpOnce = async function guardedDose(durationSec, context = {}) {
      if (context && context.manual === true) return originalDose(durationSec, context);

      const result = await synchronize('Sicherheitsprüfung vor automatischer Dosierung', true);
      if (!result || !result.ok) {
        const reason = result && result.reason ? result.reason : 'pH-Sicherheitsprüfung nicht bestanden';
        await setSafetyState(adapter, true, reason);
        if (adapter.log && typeof adapter.log.warn === 'function') adapter.log.warn(`[PH-SICHERHEIT] Automatische Dosierung blockiert: ${reason}`);
        return false;
      }

      const setpoint = Number(adapter.config.phSetpoint);
      const target = Number.isFinite(setpoint) ? setpoint : 7.2;
      const toleranceValue = Number(adapter.config.phDoseTolerance);
      const tolerance = Number.isFinite(toleranceValue) ? Math.max(0, toleranceValue) : 0.05;
      const threshold = target + tolerance;

      if (result.corrected <= threshold) {
        const reason = `Keine Dosierung: korrigiert ${result.corrected.toFixed(2)} <= Grenze ${threshold.toFixed(2)}`;
        await setSafetyState(adapter, true, reason);
        if (adapter.log && typeof adapter.log.info === 'function') adapter.log.info(`[PH-SICHERHEIT] ${reason}`);
        return false;
      }

      await setSafetyState(adapter, false, '');
      return originalDose(durationSec, { ...(context || {}), phValue: result.corrected });
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState('status.phCalibration.autoDoseBlocked', 'boolean', 'indicator', true, false);
        await adapter.ensureState('status.phCalibration.autoDoseBlockReason', 'string', 'text', 'Noch nicht geprüft', false);
        try { adapter.subscribeForeignStates(RAW_ID); } catch {}
        await synchronize('Adapterstart', true);
        scheduleNext();
        if (adapter.log && typeof adapter.log.info === 'function') {
          adapter.log.info(`[PH-SICHERHEIT] ${VERSION}: Automatische Dosierung verwendet ausschließlich Rohwert + Kalibrierdelta`);
        }
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
          adapter.log.error('[PH-SICHERHEIT] Start fehlgeschlagen: ' + (error.message || error));
        }
      }
    }, 2500));
  });

  adapter.on('stateChange', (id, state) => {
    if (id !== RAW_ID || !state || adapter.isShuttingDown) return;
    synchronize('PH803-Ereignis', true).catch(() => {});
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

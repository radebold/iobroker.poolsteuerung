'use strict';

// 0.5.29: Einzelne pH-Kalibrierpunkte sicher aus der Admin-Tabelle löschen.
const createBase = require('./main-ipadmini-final-528.js');

const VERSION = 'v0.5.29';
const HISTORY_ID = 'status.phCalibration.pointsHistoryJson';
const POINTS_ID = 'status.phCalibration.pointsJson';
const ACTIVE_ID = 'status.phCalibration.activePointJson';
const FIXED_ENABLED_ID = 'status.phCalibration.fixedEnabled';
const FIXED_POINT_ID = 'status.phCalibration.fixedPointJson';
const CLEAR_TRIGGER_ID = 'control.ph.calibration.clearFixedTrigger';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const PROTECTED_IDS = new Set([HISTORY_ID, POINTS_ID, ACTIVE_ID]);

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'yes', 'ja', 'active', 'aktiv'].includes(String(value ?? '').trim().toLowerCase());
}

function normalizePoint(point, index = 0) {
  const raw = num(point && point.raw);
  const ref = num(point && (point.ref !== undefined ? point.ref : point.poollab));
  const ts = Number(point && point.ts);
  if (raw === null || ref === null || raw < 0 || raw > 14 || ref < 0 || ref > 14) return null;
  const delta = round(ref - raw, 3);
  if (Math.abs(delta) > 0.60) return null;
  return {
    raw: round(raw, 3),
    ref: round(ref, 3),
    delta,
    ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
    index
  };
}

function samePoint(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.raw - b.raw) < 0.0005 &&
    Math.abs(a.ref - b.ref) < 0.0005 &&
    Math.abs(a.delta - b.delta) < 0.0005 &&
    (!a.ts || !b.ts || Number(a.ts) === Number(b.ts));
}

function parseJson(value, fallback) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '') : value;
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function pointJson(point) {
  return {
    raw: point.raw,
    ref: point.ref,
    delta: point.delta,
    ts: point.ts
  };
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function localId(adapter, id) {
  const text = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function rowNumberFromMessage(message) {
  if (message && typeof message === 'object') return Number(message.row);
  if (typeof message === 'string') {
    const parsed = parseJson(message, null);
    if (parsed && typeof parsed === 'object') return Number(parsed.row);
    return Number(message);
  }
  return Number(message);
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationDelete529Installed) return adapter;
  adapter.__phCalibrationDelete529Installed = true;

  let deletionBusy = false;
  const originalSendTo = typeof adapter.sendTo === 'function' ? adapter.sendTo.bind(adapter) : null;
  const originalSetStateAsync = typeof adapter.setStateAsync === 'function' ? adapter.setStateAsync.bind(adapter) : null;
  const originalSetStateIfChanged = typeof adapter.setStateIfChanged === 'function' ? adapter.setStateIfChanged.bind(adapter) : null;
  const originalSetForeignStateAsync = typeof adapter.setForeignStateAsync === 'function' ? adapter.setForeignStateAsync.bind(adapter) : null;

  // Die bestehende 0.5.28-Antwort um eine sichtbare, stabile Zeilennummer ergänzen.
  if (originalSendTo) {
    adapter.sendTo = function sendToWithCalibrationRows(...args) {
      const command = String(args[1] || '');
      const payload = args[2];
      if (
        ['phCalibrationAdminLoad', 'phCalibrationAdminSelect', 'phCalibrationAdminClear'].includes(command) &&
        payload && payload.native && Array.isArray(payload.native._calHistory)
      ) {
        payload.native = {
          ...payload.native,
          _calDeleteRow: 1,
          _calHistory: payload.native._calHistory.map((row, index) => ({ nr: index + 1, ...row }))
        };
      }
      return originalSendTo(...args);
    };
  }

  // Während der atomaren Löschung darf die ältere Latest-Offset-Schicht die drei
  // zusammengehörigen Historien-States nicht mit einem Zwischenstand zurückschreiben.
  if (originalSetStateAsync) {
    adapter.setStateAsync = async function guardedCalibrationSetState(id, value, ack, ...args) {
      if (deletionBusy && PROTECTED_IDS.has(localId(adapter, id))) return { notChanged: true };
      return originalSetStateAsync(id, value, ack, ...args);
    };
  }
  if (originalSetStateIfChanged) {
    adapter.setStateIfChanged = async function guardedCalibrationSetStateIfChanged(id, value, ack, ...args) {
      if (deletionBusy && PROTECTED_IDS.has(localId(adapter, id))) return { notChanged: true };
      return originalSetStateIfChanged(id, value, ack, ...args);
    };
  }

  async function getLocal(id) {
    try { return await adapter.getStateAsync(id); } catch { return null; }
  }

  async function waitFor(check, timeoutMs = 3500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await check()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async function clearFixedIfNeeded(target) {
    const [enabledState, pointState] = await Promise.all([
      getLocal(FIXED_ENABLED_ID),
      getLocal(FIXED_POINT_ID)
    ]);
    if (!enabledState || !boolValue(enabledState.val)) return false;
    const fixedPoint = normalizePoint(parseJson(pointState && pointState.val, {}), 0);
    if (!samePoint(target, fixedPoint)) return false;

    await originalSetStateAsync(CLEAR_TRIGGER_ID, true, false);
    const cleared = await waitFor(async () => {
      const state = await getLocal(FIXED_ENABLED_ID);
      return !state || !boolValue(state.val);
    });
    if (!cleared) throw new Error('Der ausgewählte Punkt ist aktiv. Die feste Kalibrierung konnte vor dem Löschen nicht aufgehoben werden.');
    return true;
  }

  async function deleteRow(rowNumber) {
    if (!Number.isInteger(rowNumber) || rowNumber < 1) {
      throw new Error('Bitte eine gültige Zeilennummer ab 1 eintragen.');
    }

    const historyState = await getLocal(HISTORY_ID);
    const source = parseJson(historyState && historyState.val, []);
    if (!Array.isArray(source)) throw new Error('Die Kalibrierhistorie ist ungültig.');

    const valid = source.map((point, index) => normalizePoint(point, index)).filter(Boolean);
    const displayed = valid.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0) || b.index - a.index);
    if (rowNumber > displayed.length) {
      throw new Error(`Zeile ${rowNumber} existiert nicht. Aktuell gibt es ${displayed.length} gültige Zeilen.`);
    }
    if (displayed.length <= 1) {
      throw new Error('Der letzte verbliebene Kalibrierpunkt kann aus Sicherheitsgründen nicht gelöscht werden.');
    }

    const target = displayed[rowNumber - 1];
    const fixedWasCleared = await clearFixedIfNeeded(target);
    const remainingSource = source.filter((_, index) => index !== target.index);
    const remainingValid = remainingSource.map((point, index) => normalizePoint(point, index)).filter(Boolean);
    const latest = remainingValid.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.index - b.index).pop();
    if (!latest) throw new Error('Nach dem Löschen wäre kein gültiger Kalibrierpunkt mehr vorhanden.');

    deletionBusy = true;
    try {
      const active = pointJson(latest);
      await originalSetStateAsync(HISTORY_ID, JSON.stringify(remainingSource), true);
      await originalSetStateAsync(POINTS_ID, JSON.stringify([active]), true);
      await originalSetStateAsync(ACTIVE_ID, JSON.stringify(active), true);
      await originalSetStateAsync('status.phCalibration.count', remainingValid.length, true);
      await originalSetStateAsync('status.phCalibration.lastPoollab', active.ref, true);
      await originalSetStateAsync('status.phCalibration.lastRaw', active.raw, true);
      await originalSetStateAsync('status.phCalibration.lastSavedTs', active.ts, true);
      await originalSetStateAsync('status.phCalibration.currentDelta', active.delta, true);
      await originalSetStateAsync('status.phCalibration.initialized', true, true);
      await originalSetStateAsync(
        'status.phCalibration.lastMessage',
        `Kalibrierzeile ${rowNumber} gelöscht: PH803W ${target.raw.toFixed(2)} → PoolLab ${target.ref.toFixed(2)} · Offset ${target.delta >= 0 ? '+' : ''}${target.delta.toFixed(3)} pH.`,
        true
      );

      const fixedState = await getLocal(FIXED_ENABLED_ID);
      const fixedStillEnabled = !!fixedState && boolValue(fixedState.val);
      if (!fixedStillEnabled && originalSetForeignStateAsync) {
        const rawState = await adapter.getForeignStateAsync(RAW_ID);
        const raw = num(rawState && rawState.val);
        if (raw !== null) {
          const corrected = round(raw + active.delta, 3);
          await originalSetForeignStateAsync(OUT_ID, corrected, true);
          await originalSetStateAsync('status.phCalibration.currentRaw', round(raw, 3), true);
          await originalSetStateAsync('status.phCalibration.currentCorrected', corrected, true);
          await originalSetStateAsync('status.phCalibration.effectiveCorrected', corrected, true);
          await originalSetStateAsync('status.phCalibration.effectiveMode', 'latest-offset', true);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 900));
      return {
        text: `Zeile ${rowNumber} wurde gelöscht${fixedWasCleared ? '; die bisherige feste Kalibrierung wurde dabei aufgehoben' : ''}.`
      };
    } finally {
      deletionBusy = false;
    }
  }

  function reply(obj, payload) {
    if (!obj || !obj.callback || typeof adapter.sendTo !== 'function') return;
    adapter.sendTo(obj.from, obj.command, payload, obj.callback);
  }

  adapter.on('message', obj => {
    if (!obj || adapter.isShuttingDown || obj.command !== 'phCalibrationAdminDeleteRow') return;
    const row = rowNumberFromMessage(obj.message);
    deleteRow(row)
      .then(result => reply(obj, { result: 'deleted', message: result.text, reloadBrowser: true }))
      .catch(error => reply(obj, { error: 'error', message: error.message || String(error) }));
  });

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

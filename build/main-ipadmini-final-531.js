'use strict';

// 0.5.31: Atomare Mehrfachlöschung markierter pH-Kalibrierpunkte.
// 0.5.30 verschachtelte hierfür interne sendTo-Aufrufe. Diese Version liest
// die Auswahl einmal ein und schreibt die komplette Kalibrierhistorie genau
// einmal zurück. Dadurch ist der Löschvorgang eindeutig und race-frei.
const createBase = require('./main-ipadmini-final-529.js');

const VERSION = 'v0.5.31';
const HISTORY_ID = 'status.phCalibration.pointsHistoryJson';
const POINTS_ID = 'status.phCalibration.pointsJson';
const ACTIVE_ID = 'status.phCalibration.activePointJson';
const FIXED_ENABLED_ID = 'status.phCalibration.fixedEnabled';
const FIXED_POINT_ID = 'status.phCalibration.fixedPointJson';
const CLEAR_TRIGGER_ID = 'control.ph.calibration.clearFixedTrigger';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const PROTECTED_IDS = new Set([HISTORY_ID, POINTS_ID, ACTIVE_ID]);

class CalibrationDeleteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CalibrationDeleteError';
    this.code = code;
  }
}

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.').replace(/\s*pH$/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'yes', 'ja', 'selected'].includes(
    String(value ?? '').trim().toLowerCase()
  );
}

function parseJson(value, fallback) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '') : value;
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
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

function pointJson(point) {
  return {
    raw: point.raw,
    ref: point.ref,
    delta: point.delta,
    ts: point.ts
  };
}

function localId(adapter, id) {
  const text = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function rowsFromMessage(message) {
  let payload = message;

  for (let i = 0; i < 3 && typeof payload === 'string'; i++) {
    const parsed = parseJson(payload, null);
    if (parsed === null) break;
    payload = parsed;
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.rows !== undefined) payload = payload.rows;
    else if (payload._calHistory !== undefined) payload = payload._calHistory;
  }

  for (let i = 0; i < 3 && typeof payload === 'string'; i++) {
    const parsed = parseJson(payload, null);
    if (parsed === null) break;
    payload = parsed;
  }

  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') return Object.values(payload);
  return [];
}

function getSelectedNumbers(message) {
  const rows = rowsFromMessage(message);
  const selected = rows
    .filter(row => row && typeof row === 'object' && boolValue(row.selected))
    .map(row => Number(row.nr))
    .filter(row => Number.isInteger(row) && row >= 1);

  return {
    rows,
    selected: [...new Set(selected)].sort((a, b) => a - b)
  };
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationDelete531Installed) return adapter;
  adapter.__phCalibrationDelete531Installed = true;

  let batchDeletionBusy = false;
  const originalSendTo = typeof adapter.sendTo === 'function' ? adapter.sendTo.bind(adapter) : null;
  const originalSetStateAsync = typeof adapter.setStateAsync === 'function' ? adapter.setStateAsync.bind(adapter) : null;
  const originalSetStateIfChanged = typeof adapter.setStateIfChanged === 'function' ? adapter.setStateIfChanged.bind(adapter) : null;
  const originalSetForeignStateAsync = typeof adapter.setForeignStateAsync === 'function'
    ? adapter.setForeignStateAsync.bind(adapter)
    : null;

  // Auswahlspalte bei jedem Neuladen der dynamischen Tabelle ergänzen.
  if (originalSendTo) {
    adapter.sendTo = function sendToWithCalibrationSelection(...args) {
      const command = String(args[1] || '');
      const payload = args[2];
      if (
        ['phCalibrationAdminLoad', 'phCalibrationAdminSelect', 'phCalibrationAdminClear'].includes(command) &&
        payload && payload.native && Array.isArray(payload.native._calHistory)
      ) {
        payload.native = {
          ...payload.native,
          _calHistory: payload.native._calHistory.map(row => ({ selected: false, ...row }))
        };
      }
      return originalSendTo(...args);
    };
  }

  // Während des atomaren Schreibens dürfen ältere Kalibrierschichten keine
  // Zwischenstände in die zusammengehörigen JSON-States zurückschreiben.
  if (originalSetStateAsync) {
    adapter.setStateAsync = async function guardedCalibrationBatchSetState(id, value, ack, ...args) {
      if (batchDeletionBusy && PROTECTED_IDS.has(localId(adapter, id))) return { notChanged: true };
      return originalSetStateAsync(id, value, ack, ...args);
    };
  }

  if (originalSetStateIfChanged) {
    adapter.setStateIfChanged = async function guardedCalibrationBatchSetStateIfChanged(id, value, ack, ...args) {
      if (batchDeletionBusy && PROTECTED_IDS.has(localId(adapter, id))) return { notChanged: true };
      return originalSetStateIfChanged(id, value, ack, ...args);
    };
  }

  async function getLocal(id) {
    try { return await adapter.getStateAsync(id); } catch { return null; }
  }

  async function waitFor(check, timeoutMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await check()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async function clearFixedIfSelected(targets) {
    const [enabledState, pointState] = await Promise.all([
      getLocal(FIXED_ENABLED_ID),
      getLocal(FIXED_POINT_ID)
    ]);

    if (!enabledState || !boolValue(enabledState.val)) return false;
    const fixedPoint = normalizePoint(parseJson(pointState && pointState.val, {}), 0);
    if (!fixedPoint || !targets.some(target => samePoint(target, fixedPoint))) return false;

    await originalSetStateAsync(CLEAR_TRIGGER_ID, true, false);
    const cleared = await waitFor(async () => {
      const state = await getLocal(FIXED_ENABLED_ID);
      return !state || !boolValue(state.val);
    });

    if (!cleared) {
      throw new CalibrationDeleteError(
        'fixedClearFailed',
        'Mindestens ein markierter Punkt ist aktuell festgelegt. Die Festlegung konnte vor dem Löschen nicht aufgehoben werden.'
      );
    }
    return true;
  }

  async function deleteSelected(message) {
    const selection = getSelectedNumbers(message);
    if (!selection.selected.length) {
      throw new CalibrationDeleteError('noSelection', 'Bitte zuerst mindestens eine Tabellenzeile markieren.');
    }

    const historyState = await getLocal(HISTORY_ID);
    const source = parseJson(historyState && historyState.val, []);
    if (!Array.isArray(source)) {
      throw new CalibrationDeleteError('invalidHistory', 'Die gespeicherte Kalibrierhistorie ist kein gültiges Array.');
    }

    const valid = source.map((point, index) => normalizePoint(point, index)).filter(Boolean);
    const displayed = valid
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0) || b.index - a.index);

    const invalidRows = selection.selected.filter(nr => nr > displayed.length);
    if (invalidRows.length) {
      throw new CalibrationDeleteError(
        'invalidSelection',
        `Die markierte Zeile ${invalidRows.join(', ')} existiert nicht mehr. Bitte die Auswertung neu laden.`
      );
    }

    if (selection.selected.length >= displayed.length) {
      throw new CalibrationDeleteError(
        'allSelected',
        'Mindestens ein Kalibrierpunkt muss erhalten bleiben. Bitte nicht alle Zeilen markieren.'
      );
    }

    const targets = selection.selected.map(nr => displayed[nr - 1]);
    const sourceIndexes = new Set(targets.map(target => target.index));
    const fixedWasCleared = await clearFixedIfSelected(targets);
    const remainingSource = source.filter((_, index) => !sourceIndexes.has(index));
    const remainingValid = remainingSource
      .map((point, index) => normalizePoint(point, index))
      .filter(Boolean);

    if (!remainingValid.length) {
      throw new CalibrationDeleteError('allSelected', 'Nach dem Löschen wäre kein gültiger Kalibrierpunkt mehr vorhanden.');
    }

    const latest = remainingValid
      .slice()
      .sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.index - b.index)
      .pop();
    const active = pointJson(latest);

    batchDeletionBusy = true;
    try {
      // Alle zusammengehörigen States werden aus genau demselben Datenstand geschrieben.
      await originalSetStateAsync(HISTORY_ID, JSON.stringify(remainingSource), true);
      await originalSetStateAsync(POINTS_ID, JSON.stringify([active]), true);
      await originalSetStateAsync(ACTIVE_ID, JSON.stringify(active), true);
      await originalSetStateAsync('status.phCalibration.count', remainingValid.length, true);
      await originalSetStateAsync('status.phCalibration.lastPoollab', active.ref, true);
      await originalSetStateAsync('status.phCalibration.lastRaw', active.raw, true);
      await originalSetStateAsync('status.phCalibration.lastSavedTs', active.ts, true);
      await originalSetStateAsync('status.phCalibration.currentDelta', active.delta, true);
      await originalSetStateAsync('status.phCalibration.initialized', true, true);

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

      const deletedText = targets
        .map(target => `PH803W ${target.raw.toFixed(2)} → PoolLab ${target.ref.toFixed(2)}`)
        .join(' | ');
      await originalSetStateAsync(
        'status.phCalibration.lastMessage',
        `${targets.length} Kalibrierpunkt${targets.length === 1 ? '' : 'e'} gelöscht: ${deletedText}${fixedWasCleared ? ' · feste Kalibrierung aufgehoben' : ''}`,
        true
      );

      // Genug Zeit für abhängige Analyse-Listener, ohne einen Zwischenstand freizugeben.
      await new Promise(resolve => setTimeout(resolve, 350));
      return {
        deleted: targets.length,
        fixedWasCleared
      };
    } finally {
      batchDeletionBusy = false;
    }
  }

  function reply(obj, payload) {
    if (!obj || !obj.callback || typeof adapter.sendTo !== 'function') return;
    adapter.sendTo(obj.from, obj.command, payload, obj.callback);
  }

  adapter.on('message', obj => {
    if (!obj || adapter.isShuttingDown || obj.command !== 'phCalibrationAdminDeleteSelected') return;

    deleteSelected(obj.message)
      .then(result => reply(obj, {
        result: 'deleted',
        message: `${result.deleted} markierte Kalibrierzeile${result.deleted === 1 ? '' : 'n'} wurde${result.deleted === 1 ? '' : 'n'} gelöscht.`,
        reloadBrowser: true
      }))
      .catch(error => {
        const code = error && error.code ? error.code : 'deleteFailed';
        const message = error && error.message ? error.message : String(error);
        if (adapter.log) {
          adapter.log.error(`[PH-KAL 0.5.31] Löschen fehlgeschlagen (${code}): ${message}`);
        }
        reply(obj, { error: code, message });
      });
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

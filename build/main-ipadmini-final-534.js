'use strict';

// 0.5.34: Autoritativer pH-Pfad fuer Regelung und alle VIS.
// Der angezeigte/regelte pH-Wert kommt ausschliesslich aus PH803W-Rohwert
// plus aktivem Kalibrieroffset. Falsche konfigurierte pH-Quellen (z. B.
// Kanistergewicht) werden nur zur Laufzeit ersetzt; die Adapterkonfiguration
// wird dabei nicht in native zurueckgeschrieben.
const createBase = require('./main-ipadmini-final-533.js');

const VERSION = 'v0.5.34';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const FIXED_ENABLED_ID = 'status.phCalibration.fixedEnabled';
const FIXED_OFFSET_ID = 'status.phCalibration.fixedOffset';
const FIXED_POINT_ID = 'status.phCalibration.fixedPointJson';
const POINTS_ID = 'status.phCalibration.pointsJson';
const ACTIVE_ID = 'status.phCalibration.activePointJson';
const CURRENT_DELTA_ID = 'status.phCalibration.currentDelta';
const HISTORY_IDS = [
  'status.trend.ipadMiniLocal24hJson',
  'status.trend.phTodayJson'
];

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
  return ['true', '1', 'on', 'ein', 'yes', 'ja', 'active', 'aktiv'].includes(
    String(value ?? '').trim().toLowerCase()
  );
}

function plausiblePoolPh(value) {
  const parsed = num(value);
  return parsed !== null && parsed >= 5.5 && parsed <= 9.5;
}

function plausibleDelta(value) {
  const parsed = num(value);
  return parsed !== null && Math.abs(parsed) <= 0.60;
}

function parseJson(value, fallback) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '') : value;
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function localId(adapter, id) {
  const text = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function install(adapter) {
  if (!adapter || adapter.__phAuthoritative534Installed) return adapter;
  adapter.__phAuthoritative534Installed = true;
  adapter.__phAuthoritative534 = null;
  adapter.__phAuthoritativeRaw534 = null;
  adapter.__phAuthoritativeSyncBusy534 = false;
  adapter.__phAuthoritativeErrorLogged534 = false;
  adapter.__phOriginalStateId534 = '';

  const originalSetForeignStateAsync = typeof adapter.setForeignStateAsync === 'function'
    ? adapter.setForeignStateAsync.bind(adapter)
    : null;

  async function getLocal(id) {
    try { return await adapter.getStateAsync(id); } catch { return null; }
  }

  async function getForeign(id) {
    try { return await adapter.getForeignStateAsync(id); } catch { return null; }
  }

  async function ensureDebugObjects() {
    await adapter.setObjectNotExistsAsync('status.debug.phAuthoritative534', {
      type: 'state',
      common: {
        name: 'Autoritativer pH-Pfad 0.5.34',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: ''
      },
      native: {}
    });
    await adapter.setObjectNotExistsAsync('status.debug.phRejectedSource534', {
      type: 'state',
      common: {
        name: 'Verworfene pH-Quelle 0.5.34',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: ''
      },
      native: {}
    });
  }

  async function readFixedCalibration() {
    const [enabledState, offsetState, pointState] = await Promise.all([
      getLocal(FIXED_ENABLED_ID),
      getLocal(FIXED_OFFSET_ID),
      getLocal(FIXED_POINT_ID)
    ]);
    const enabled = !!enabledState && boolValue(enabledState.val);
    const offset = num(offsetState && offsetState.val);
    const point = parseJson(pointState && pointState.val, null);
    return {
      enabled: enabled && plausibleDelta(offset),
      offset: plausibleDelta(offset) ? round(offset, 3) : null,
      point: point && typeof point === 'object' ? point : null
    };
  }

  async function determineAuthoritative() {
    const rawState = await getForeign(RAW_ID);
    const raw = num(rawState && rawState.val);
    if (!plausiblePoolPh(raw)) {
      return { ok: false, reason: `PH803W-Rohwert unplausibel oder nicht verfuegbar: ${raw}` };
    }

    const fixed = await readFixedCalibration();
    if (fixed.enabled && fixed.offset !== null) {
      const corrected = round(raw + fixed.offset, 3);
      if (plausiblePoolPh(corrected)) {
        return {
          ok: true,
          raw: round(raw, 3),
          corrected,
          offset: fixed.offset,
          source: 'fixed-robust-median-point',
          fixedPoint: fixed.point
        };
      }
    }

    const deltaState = await getLocal(CURRENT_DELTA_ID);
    const delta = num(deltaState && deltaState.val);
    if (plausibleDelta(delta)) {
      const corrected = round(raw + delta, 3);
      if (plausiblePoolPh(corrected)) {
        return {
          ok: true,
          raw: round(raw, 3),
          corrected,
          offset: round(delta, 3),
          source: 'currentDelta',
          fixedPoint: null
        };
      }
    }

    const outputState = await getForeign(OUT_ID);
    const output = num(outputState && outputState.val);
    if (plausiblePoolPh(output) && Math.abs(output - raw) <= 0.60) {
      return {
        ok: true,
        raw: round(raw, 3),
        corrected: round(output, 3),
        offset: round(output - raw, 3),
        source: 'value_korr',
        fixedPoint: null
      };
    }

    const fallbackOffset = -0.21;
    return {
      ok: true,
      raw: round(raw, 3),
      corrected: round(raw + fallbackOffset, 3),
      offset: fallbackOffset,
      source: 'safety-fallback--0.21',
      fixedPoint: null
    };
  }

  async function diagnoseConfiguredSource(result) {
    if (!adapter.__phOriginalStateId534) {
      adapter.__phOriginalStateId534 = String(
        adapter.config && adapter.config.phStateId ? adapter.config.phStateId : ''
      ).trim();
    }
    const configuredId = adapter.__phOriginalStateId534;
    if (!configuredId || configuredId === OUT_ID) {
      await adapter.setStateIfChanged('status.debug.phRejectedSource534', '', true).catch(() => {});
      return;
    }

    const state = await getForeign(configuredId);
    const value = num(state && state.val);
    const rejected = !plausiblePoolPh(value) || Math.abs(value - result.raw) > 0.60;
    if (!rejected) return;

    const text =
      `VERWORFEN: ${configuredId} = ${value === null ? '--' : value}` +
      ` · PH803W roh ${result.raw.toFixed(3)}` +
      ` · stattdessen ${OUT_ID} = ${result.corrected.toFixed(3)}`;
    await adapter.setStateIfChanged('status.debug.phRejectedSource534', text, true).catch(() => {});

    if (!adapter.__phAuthoritativeErrorLogged534 && adapter.log) {
      adapter.__phAuthoritativeErrorLogged534 = true;
      adapter.log.error(`[PH-SICHERHEIT 0.5.34] ${text}`);
    }
  }

  async function alignLegacyCalibration(result) {
    if (!result || !result.ok) return;
    adapter.__phCentral059Raw = result.raw;
    adapter.__phCentral059Corrected = result.corrected;
    adapter.__phPolling057LastRaw = result.raw;
    adapter.__phPolling057LastCorrected = result.corrected;

    const fixed = await readFixedCalibration();
    if (fixed.enabled && fixed.point) {
      const point = {
        raw: round(num(fixed.point.raw), 3),
        ref: round(num(fixed.point.ref), 3),
        delta: result.offset,
        ts: Number(fixed.point.ts) || 0
      };
      if (
        plausiblePoolPh(point.raw) &&
        plausiblePoolPh(point.ref) &&
        plausibleDelta(point.delta)
      ) {
        const json = JSON.stringify([point]);
        await adapter.setStateIfChanged(POINTS_ID, json, true);
        await adapter.setStateIfChanged(ACTIVE_ID, JSON.stringify(point), true);
      }
    }
  }

  async function syncAuthoritative(reason = 'sync') {
    if (adapter.isShuttingDown || adapter.__phAuthoritativeSyncBusy534) {
      return adapter.__phAuthoritative534 === null
        ? null
        : {
            ok: true,
            raw: adapter.__phAuthoritativeRaw534,
            corrected: adapter.__phAuthoritative534
          };
    }

    adapter.__phAuthoritativeSyncBusy534 = true;
    try {
      await ensureDebugObjects();

      if (!adapter.__phOriginalStateId534) {
        adapter.__phOriginalStateId534 = String(
          adapter.config && adapter.config.phStateId ? adapter.config.phStateId : ''
        ).trim();
      }

      // Nur Laufzeitkorrektur: kein Schreiben nach system.adapter.* und damit kein Neustart.
      if (adapter.config) adapter.config.phStateId = OUT_ID;

      const result = await determineAuthoritative();
      if (!result.ok) {
        await adapter.setStateIfChanged(
          'status.debug.phAuthoritative534',
          `BLOCKIERT: ${result.reason}`,
          true
        ).catch(() => {});
        return result;
      }

      if (originalSetForeignStateAsync) {
        await originalSetForeignStateAsync(OUT_ID, result.corrected, true);
      }

      adapter.__phAuthoritativeRaw534 = result.raw;
      adapter.__phAuthoritative534 = result.corrected;

      await adapter.setStateIfChanged('status.phCalibration.currentRaw', result.raw, true);
      await adapter.setStateIfChanged('status.phCalibration.currentCorrected', result.corrected, true);
      await adapter.setStateIfChanged('status.phCalibration.currentDelta', result.offset, true);
      await adapter.setStateIfChanged('status.phCalibration.effectiveCorrected', result.corrected, true);

      await alignLegacyCalibration(result);
      await diagnoseConfiguredSource(result);

      const configured = adapter.__phOriginalStateId534 || '--';
      await adapter.setStateIfChanged(
        'status.debug.phAuthoritative534',
        `${reason} · PH803W ${result.raw.toFixed(3)} + ${result.offset >= 0 ? '+' : ''}${result.offset.toFixed(3)}` +
          ` = ${result.corrected.toFixed(3)} pH · Quelle ${result.source}` +
          ` · VIS/Regelung ${OUT_ID} · vorher konfiguriert ${configured}`,
        true
      );

      return result;
    } finally {
      adapter.__phAuthoritativeSyncBusy534 = false;
    }
  }

  function filterPhRows(rows) {
    if (!Array.isArray(rows)) return { rows: [], removed: 0 };
    const filtered = rows.filter(row => {
      const value = num(row && row.val !== undefined ? row.val : row);
      return plausiblePoolPh(value);
    });
    return { rows: filtered, removed: rows.length - filtered.length };
  }

  async function cleanInvalidHistory() {
    let removedTotal = 0;

    const localState = await getLocal(HISTORY_IDS[0]);
    const local = parseJson(localState && localState.val, {});
    if (local && typeof local === 'object' && !Array.isArray(local)) {
      const filtered = filterPhRows(local.ph);
      if (filtered.removed > 0) {
        local.ph = filtered.rows;
        await adapter.setStateIfChanged(HISTORY_IDS[0], JSON.stringify(local), true);
        removedTotal += filtered.removed;
      }
    }

    const todayState = await getLocal(HISTORY_IDS[1]);
    const today = parseJson(todayState && todayState.val, []);
    if (Array.isArray(today)) {
      const filtered = filterPhRows(today);
      if (filtered.removed > 0) {
        await adapter.setStateIfChanged(HISTORY_IDS[1], JSON.stringify(filtered.rows), true);
        removedTotal += filtered.removed;
      }
    }

    if (removedTotal > 0 && adapter.log) {
      adapter.log.error(
        `[PH-SICHERHEIT 0.5.34] ${removedTotal} unplausible pH-Verlaufspunkt(e) ausserhalb 5,5–9,5 entfernt.`
      );
    }
    return removedTotal;
  }

  // Noch vor dem ersten ready-Zyklus die bekannte korrigierte pH-Quelle verwenden.
  if (adapter.config) {
    adapter.__phOriginalStateId534 = String(adapter.config.phStateId || '').trim();
    adapter.config.phStateId = OUT_ID;
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const authoritative = adapter.__phAuthoritative534;
      const next = {
        ...(data || {}),
        adapterVersion: VERSION
      };
      if (plausiblePoolPh(authoritative)) {
        next.ph = authoritative;
        next.phInRange = authoritative >= 7.0 && authoritative <= 7.4;
      }
      return patchVersion(original(next));
    };
  }

  if (typeof adapter.applyControlLogic === 'function') {
    const originalApplyControlLogic = adapter.applyControlLogic.bind(adapter);
    adapter.applyControlLogic = async function applyControlLogicWithAuthoritativePh(...args) {
      await syncAuthoritative('vor Regelzyklus');
      return originalApplyControlLogic(...args);
    };
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRenderVisFull = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullWithAuthoritativePh(...args) {
      await syncAuthoritative('vor VIS-Render');
      const result = await originalRenderVisFull(...args);
      await cleanInvalidHistory();
      return result;
    };
  }

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown) return;
    const normalized = localId(adapter, id);
    const relevant =
      id === RAW_ID ||
      normalized === FIXED_ENABLED_ID ||
      normalized === FIXED_OFFSET_ID ||
      normalized === FIXED_POINT_ID;
    if (!relevant) return;

    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      const result = await syncAuthoritative(`State-Aenderung ${normalized || id}`);
      if (result && result.ok) {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        try { adapter.queueRender(); } catch {}
      }
    }, 80));
  });

  async function boot(source) {
    if (adapter.isShuttingDown) return;
    try { adapter.subscribeForeignStates(RAW_ID); } catch {}
    try { adapter.subscribeStates(FIXED_ENABLED_ID); } catch {}
    try { adapter.subscribeStates(FIXED_OFFSET_ID); } catch {}
    try { adapter.subscribeStates(FIXED_POINT_ID); } catch {}
    await syncAuthoritative(`Start ${source}`);
    await cleanInvalidHistory();
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    try { await adapter.forceImmediateRender(); } catch {}
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      try {
        await boot('ready');
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) {
          adapter.log.error(`[PH-SICHERHEIT 0.5.34] Startfehler: ${error.message || error}`);
        }
      }
    }, 450));
  });

  for (const delay of [1400, 4200]) {
    const handle = setTimeout(() => {
      if (!adapter.isShuttingDown) boot(`fallback-${delay}`).catch(() => {});
    }, delay);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(handle);
  }

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

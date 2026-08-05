'use strict';

// 0.5.27: Robuste pH-Kalibrierung mit festem, bewusst gewaehltem Kalibrierpunkt.
// - Die komplette PoolLab-Historie bleibt erhalten.
// - Empfehlung = historischer Messpunkt, dessen Delta dem Median aller gueltigen Deltas am naechsten liegt.
// - Ein einmal festgelegter Punkt bleibt aktiv, bis der Benutzer ihn neu ermittelt oder die Festlegung aufhebt.
// - Neue PoolLab-Messungen erweitern nur die Historie und veraendern den festen Offset nicht automatisch.
// - Admin-Tab liefert eine lesbare Auswertung ohne JSON-Handarbeit.
const createBase = require('./main-ipadmini-final-526.js');

const VERSION = 'v0.5.27';
const HISTORY_ID = 'status.phCalibration.pointsHistoryJson';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';

const IDS = {
  fixedEnabled: 'status.phCalibration.fixedEnabled',
  fixedOffset: 'status.phCalibration.fixedOffset',
  fixedPoint: 'status.phCalibration.fixedPointJson',
  fixedSince: 'status.phCalibration.fixedSince',
  median: 'status.phCalibration.robustMedianDelta',
  mad: 'status.phCalibration.robustMad',
  recommended: 'status.phCalibration.recommendedPointJson',
  effectiveMode: 'status.phCalibration.effectiveMode',
  effectiveCorrected: 'status.phCalibration.effectiveCorrected',
  analysisSummary: 'status.phCalibration.analysisSummary',
  selectTrigger: 'control.ph.calibration.selectBestTrigger',
  clearTrigger: 'control.ph.calibration.clearFixedTrigger'
};

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function fmt(value, digits = 2) {
  const parsed = num(value);
  return parsed === null ? '--' : parsed.toFixed(digits).replace('.', ',');
}

function signed(value, digits = 2) {
  const parsed = num(value);
  if (parsed === null) return '--';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(digits).replace('.', ',')}`;
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'yes', 'ja', 'active', 'aktiv'].includes(String(value ?? '').trim().toLowerCase());
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

function parsePoints(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source || '[]'); } catch { source = []; }
  }
  return (Array.isArray(source) ? source : [])
    .map((point, index) => normalizePoint(point, index))
    .filter(Boolean)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.index - b.index);
}

function samePoint(a, b) {
  return !!a && !!b &&
    Math.abs(Number(a.raw) - Number(b.raw)) <= 0.0005 &&
    Math.abs(Number(a.ref) - Number(b.ref)) <= 0.0005 &&
    Math.abs(Number(a.delta) - Number(b.delta)) <= 0.0005 &&
    Number(a.ts || 0) === Number(b.ts || 0);
}

function dateText(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return '--';
  try {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(Number(ts))).replace(',', '');
  } catch {
    return new Date(Number(ts)).toLocaleString('de-DE');
  }
}

function analyzePoints(pointsValue) {
  const points = parsePoints(pointsValue);
  if (!points.length) {
    return { points: [], medianDelta: null, mad: null, recommended: null };
  }

  const deltas = points.map(point => point.delta);
  const medianDelta = round(median(deltas), 3);
  const deviations = deltas.map(delta => Math.abs(delta - medianDelta));
  const mad = round(median(deviations) || 0, 3);

  const recommended = points
    .slice()
    .sort((a, b) => {
      const distA = Math.abs(a.delta - medianDelta);
      const distB = Math.abs(b.delta - medianDelta);
      if (Math.abs(distA - distB) > 0.0005) return distA - distB;
      return (b.ts || 0) - (a.ts || 0);
    })[0];

  return { points, medianDelta, mad, recommended };
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function localId(adapter, id) {
  const full = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

function install(adapter) {
  if (!adapter || adapter.__robustPhCalibration527Installed) return adapter;
  adapter.__robustPhCalibration527Installed = true;

  const originalSetForeignStateAsync = typeof adapter.setForeignStateAsync === 'function'
    ? adapter.setForeignStateAsync.bind(adapter)
    : null;
  const originalSetForeignStateChangedAsync = typeof adapter.setForeignStateChangedAsync === 'function'
    ? adapter.setForeignStateChangedAsync.bind(adapter)
    : null;

  let fixed = { enabled: false, offset: null, point: null, since: 0 };
  let analysisBusy = false;

  async function createState(id, common) {
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
  }

  async function ensureObjects() {
    await adapter.setObjectNotExistsAsync('status.phCalibration', {
      type: 'channel', common: { name: 'pH-Kalibrierung' }, native: {}
    });
    await adapter.setObjectNotExistsAsync('control.ph.calibration', {
      type: 'channel', common: { name: 'pH-Kalibrierung' }, native: {}
    });

    await createState(IDS.fixedEnabled, {
      name: 'Fester robuster Kalibrierpunkt aktiv', type: 'boolean', role: 'indicator', read: true, write: false, def: false
    });
    await createState(IDS.fixedOffset, {
      name: 'Festgelegter pH-Offset', type: 'number', role: 'value', read: true, write: false, unit: 'pH', def: 0
    });
    await createState(IDS.fixedPoint, {
      name: 'Festgelegter Kalibrierpunkt', type: 'string', role: 'json', read: true, write: false, def: '{}'
    });
    await createState(IDS.fixedSince, {
      name: 'Kalibrierpunkt festgelegt am', type: 'number', role: 'value.time', read: true, write: false, def: 0
    });
    await createState(IDS.median, {
      name: 'Robuster Median der Kalibrierdifferenzen', type: 'number', role: 'value', read: true, write: false, unit: 'pH', def: 0
    });
    await createState(IDS.mad, {
      name: 'Median absolute deviation der Kalibrierdifferenzen', type: 'number', role: 'value', read: true, write: false, unit: 'pH', def: 0
    });
    await createState(IDS.recommended, {
      name: 'Empfohlener Kalibrierpunkt', type: 'string', role: 'json', read: true, write: false, def: '{}'
    });
    await createState(IDS.effectiveMode, {
      name: 'Effektiver pH-Kalibriermodus', type: 'string', role: 'text', read: true, write: false, def: 'latest-offset'
    });
    await createState(IDS.effectiveCorrected, {
      name: 'Effektiv korrigierter pH-Wert', type: 'number', role: 'value.ph', read: true, write: false, unit: 'pH'
    });
    await createState(IDS.analysisSummary, {
      name: 'Zusammenfassung Kalibrierauswertung', type: 'string', role: 'text', read: true, write: false, def: ''
    });
    await createState(IDS.selectTrigger, {
      name: 'Besten Kalibrierpunkt ermitteln und festlegen', type: 'boolean', role: 'button', read: true, write: true, def: false
    });
    await createState(IDS.clearTrigger, {
      name: 'Feste Kalibrierung aufheben', type: 'boolean', role: 'button', read: true, write: true, def: false
    });
  }

  async function readFixed() {
    const [enabledState, offsetState, pointState, sinceState] = await Promise.all([
      adapter.getStateAsync(IDS.fixedEnabled),
      adapter.getStateAsync(IDS.fixedOffset),
      adapter.getStateAsync(IDS.fixedPoint),
      adapter.getStateAsync(IDS.fixedSince)
    ]);

    let point = null;
    try { point = normalizePoint(JSON.parse(String((pointState && pointState.val) || '{}'))); } catch {}
    const offset = num(offsetState && offsetState.val);
    const enabled = !!(enabledState && boolValue(enabledState.val) && offset !== null && point);
    fixed = {
      enabled,
      offset: enabled ? round(offset, 3) : null,
      point: enabled ? point : null,
      since: Number(sinceState && sinceState.val) || 0
    };
    return fixed;
  }

  async function readHistory() {
    const state = await adapter.getStateAsync(HISTORY_ID);
    return parsePoints(String((state && state.val) || '[]'));
  }

  async function readRaw() {
    try {
      const state = await adapter.getForeignStateAsync(RAW_ID);
      const raw = num(state && state.val);
      return raw === null ? null : raw;
    } catch {
      return null;
    }
  }

  async function applyEffectiveCorrection() {
    if (!fixed.enabled || fixed.offset === null) return null;
    const raw = await readRaw();
    if (raw === null) return null;
    const corrected = round(raw + fixed.offset, 3);
    if (originalSetForeignStateAsync) await originalSetForeignStateAsync(OUT_ID, corrected, true);
    await adapter.setStateIfChanged(IDS.effectiveCorrected, corrected, true);
    await adapter.setStateIfChanged(IDS.effectiveMode, 'fixed-robust-median-point', true);
    return corrected;
  }

  async function refreshAnalysisStates() {
    if (analysisBusy) return null;
    analysisBusy = true;
    try {
      const points = await readHistory();
      const analysis = analyzePoints(points);
      await adapter.setStateIfChanged(IDS.median, analysis.medianDelta === null ? 0 : analysis.medianDelta, true);
      await adapter.setStateIfChanged(IDS.mad, analysis.mad === null ? 0 : analysis.mad, true);
      await adapter.setStateIfChanged(IDS.recommended, JSON.stringify(analysis.recommended || {}), true);
      const summary = analysis.recommended
        ? `${analysis.points.length} Messpunkte · Median ${signed(analysis.medianDelta, 3)} · Empfehlung PH803W ${fmt(analysis.recommended.raw, 2)} → PoolLab ${fmt(analysis.recommended.ref, 2)} · Δ ${signed(analysis.recommended.delta, 3)}`
        : 'Keine gültigen Kalibrierpunkte vorhanden.';
      await adapter.setStateIfChanged(IDS.analysisSummary, summary, true);
      return analysis;
    } finally {
      analysisBusy = false;
    }
  }

  async function selectBest() {
    const analysis = await refreshAnalysisStates();
    if (!analysis || !analysis.recommended) throw new Error('Keine gültigen Kalibrierpunkte vorhanden');
    const point = analysis.recommended;
    const since = Date.now();
    fixed = { enabled: true, offset: point.delta, point, since };

    await adapter.setStateIfChanged(IDS.fixedPoint, JSON.stringify({ raw: point.raw, ref: point.ref, delta: point.delta, ts: point.ts }), true);
    await adapter.setStateIfChanged(IDS.fixedOffset, point.delta, true);
    await adapter.setStateIfChanged(IDS.fixedSince, since, true);
    await adapter.setStateIfChanged(IDS.fixedEnabled, true, true);
    await adapter.setStateIfChanged(IDS.effectiveMode, 'fixed-robust-median-point', true);
    await applyEffectiveCorrection();

    return {
      point,
      medianDelta: analysis.medianDelta,
      mad: analysis.mad,
      text: `Festgelegt: PH803W ${fmt(point.raw, 2)} → PoolLab ${fmt(point.ref, 2)} · Offset ${signed(point.delta, 3)} pH`
    };
  }

  async function clearFixed() {
    fixed = { enabled: false, offset: null, point: null, since: 0 };
    await adapter.setStateIfChanged(IDS.fixedEnabled, false, true);
    await adapter.setStateIfChanged(IDS.fixedOffset, 0, true);
    await adapter.setStateIfChanged(IDS.fixedPoint, '{}', true);
    await adapter.setStateIfChanged(IDS.fixedSince, 0, true);
    await adapter.setStateIfChanged(IDS.effectiveMode, 'latest-offset', true);
    return { text: 'Feste Kalibrierung aufgehoben. Es gilt wieder der bisherige Neuester-Punkt-Modus.' };
  }

  async function buildAdminData() {
    await readFixed();
    const points = await readHistory();
    const analysis = analyzePoints(points);
    const raw = await readRaw();
    const currentCorrected = raw === null
      ? null
      : fixed.enabled && fixed.offset !== null
        ? round(raw + fixed.offset, 3)
        : null;

    const history = analysis.points
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0) || b.index - a.index)
      .map(point => {
        const distance = analysis.medianDelta === null ? null : Math.abs(point.delta - analysis.medianDelta);
        const tags = [];
        if (fixed.enabled && samePoint(point, fixed.point)) tags.push('AKTIV');
        if (analysis.recommended && samePoint(point, analysis.recommended)) tags.push('EMPFOHLEN');
        if (!tags.length) {
          const limit = Math.max(0.10, (analysis.mad || 0) * 2);
          tags.push(distance !== null && distance > limit ? 'abweichend' : 'Historie');
        }
        return {
          date: dateText(point.ts),
          raw: fmt(point.raw, 2),
          ref: fmt(point.ref, 2),
          delta: signed(point.delta, 3),
          distance: distance === null ? '--' : fmt(distance, 3),
          status: tags.join(' · ')
        };
      });

    const recommendedText = analysis.recommended
      ? `PH803W ${fmt(analysis.recommended.raw, 2)} → PoolLab ${fmt(analysis.recommended.ref, 2)} · Δ ${signed(analysis.recommended.delta, 3)} pH · ${dateText(analysis.recommended.ts)}`
      : 'Kein gültiger Vorschlag vorhanden';
    const fixedText = fixed.enabled && fixed.point
      ? `PH803W ${fmt(fixed.point.raw, 2)} → PoolLab ${fmt(fixed.point.ref, 2)} · Δ ${signed(fixed.offset, 3)} pH · festgelegt ${dateText(fixed.since)}`
      : 'Noch kein Kalibrierpunkt festgelegt – aktuell arbeitet weiterhin die bisherige Neuester-Punkt-Logik.';

    return {
      mode: fixed.enabled ? 'FEST: robuster historischer Kalibrierpunkt' : 'AUTO: bisheriger neuester Kalibrierpunkt',
      measurementCount: String(analysis.points.length),
      medianDelta: analysis.medianDelta === null ? '--' : `${signed(analysis.medianDelta, 3)} pH`,
      mad: analysis.mad === null ? '--' : `${fmt(analysis.mad, 3)} pH`,
      recommended: recommendedText,
      fixed: fixedText,
      current: raw === null
        ? 'PH803W-Rohwert nicht verfügbar'
        : fixed.enabled
          ? `Aktuell ${fmt(raw, 2)} + (${signed(fixed.offset, 3)}) = ${fmt(currentCorrected, 3)} pH`
          : `Aktueller PH803W-Rohwert ${fmt(raw, 2)} pH`,
      history
    };
  }

  async function reply(obj, payload) {
    if (!obj || !obj.callback || !adapter.sendTo) return;
    adapter.sendTo(obj.from, obj.command, payload, obj.callback);
  }

  adapter.on('message', obj => {
    if (!obj || adapter.isShuttingDown) return;
    if (obj.command === 'phCalibrationTab') {
      buildAdminData()
        .then(data => reply(obj, { data }))
        .catch(error => reply(obj, { data: { mode: `Fehler: ${error.message || error}`, history: [] } }));
      return;
    }
    if (obj.command === 'phCalibrationSelectBest') {
      selectBest()
        .then(result => reply(obj, { result: 'ok', message: result.text, reloadBrowser: true }))
        .catch(error => reply(obj, { error: 'error', message: error.message || String(error) }));
      return;
    }
    if (obj.command === 'phCalibrationClearFixed') {
      clearFixed()
        .then(result => reply(obj, { result: 'cleared', message: result.text, reloadBrowser: true }))
        .catch(error => reply(obj, { error: 'error', message: error.message || String(error) }));
      return;
    }
    if (obj.command === 'phCalibrationRefresh') {
      refreshAnalysisStates()
        .then(() => reply(obj, { result: 'ok', reloadBrowser: true }))
        .catch(error => reply(obj, { error: 'error', message: error.message || String(error) }));
    }
  });

  // Der feste Offset ist die letzte Instanz vor dem korrigierten PH803-Ausgang.
  // Dadurch kann die alte Latest-Offset-Schicht weiterhin die Historie pflegen,
  // ohne einen bewusst festgelegten Offset bei einer neuen Messung zu ueberschreiben.
  if (originalSetForeignStateAsync) {
    adapter.setForeignStateAsync = async function robustCalibrationForeignWrite(id, value, ...args) {
      if (String(id) === OUT_ID && fixed.enabled && fixed.offset !== null) {
        const raw = await readRaw();
        if (raw !== null) {
          const corrected = round(raw + fixed.offset, 3);
          await adapter.setStateIfChanged(IDS.effectiveCorrected, corrected, true).catch(() => {});
          await adapter.setStateIfChanged(IDS.effectiveMode, 'fixed-robust-median-point', true).catch(() => {});
          return originalSetForeignStateAsync(id, corrected, true);
        }
      }
      return originalSetForeignStateAsync(id, value, ...args);
    };
  }

  if (originalSetForeignStateChangedAsync) {
    adapter.setForeignStateChangedAsync = async function robustCalibrationForeignChangedWrite(id, value, ...args) {
      if (String(id) === OUT_ID && fixed.enabled && fixed.offset !== null) {
        const raw = await readRaw();
        if (raw !== null) {
          const corrected = round(raw + fixed.offset, 3);
          await adapter.setStateIfChanged(IDS.effectiveCorrected, corrected, true).catch(() => {});
          await adapter.setStateIfChanged(IDS.effectiveMode, 'fixed-robust-median-point', true).catch(() => {});
          return originalSetForeignStateChangedAsync(id, corrected, true);
        }
      }
      return originalSetForeignStateChangedAsync(id, value, ...args);
    };
  }

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown) return;
    const normalized = localId(adapter, id);

    if (normalized === IDS.selectTrigger && state.ack === false && boolValue(state.val)) {
      selectBest()
        .catch(error => adapter.log && adapter.log.error(`[PH-KAL 0.5.27] Festlegen fehlgeschlagen: ${error.message || error}`))
        .finally(() => adapter.setStateIfChanged(IDS.selectTrigger, false, true).catch(() => {}));
      return;
    }

    if (normalized === IDS.clearTrigger && state.ack === false && boolValue(state.val)) {
      clearFixed()
        .catch(error => adapter.log && adapter.log.error(`[PH-KAL 0.5.27] Aufheben fehlgeschlagen: ${error.message || error}`))
        .finally(() => adapter.setStateIfChanged(IDS.clearTrigger, false, true).catch(() => {}));
      return;
    }

    if (normalized === HISTORY_ID) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (!adapter.isShuttingDown) await refreshAnalysisStates().catch(() => {});
      }, 150));
    }
  });

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function boot(source) {
    if (adapter.isShuttingDown) return;
    await ensureObjects();
    try { adapter.subscribeStates(HISTORY_ID); } catch {}
    try { adapter.subscribeStates(IDS.selectTrigger); } catch {}
    try { adapter.subscribeStates(IDS.clearTrigger); } catch {}
    await readFixed();
    await refreshAnalysisStates();
    if (fixed.enabled) await applyEffectiveCorrection();
    else await adapter.setStateIfChanged(IDS.effectiveMode, 'latest-offset', true);
    if (adapter.config && adapter.config.debugMode && adapter.log && typeof adapter.log.info === 'function') {
      adapter.log.info(`[PH-KAL 0.5.27] Robuste Kalibrierung initialisiert (${source}); fixed=${fixed.enabled}`);
    }
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      try { await boot('ready'); } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) adapter.log.error(`[PH-KAL 0.5.27] Startfehler: ${error.message || error}`);
      }
    }, 300));
  });

  for (const delay of [1200, 3500]) {
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

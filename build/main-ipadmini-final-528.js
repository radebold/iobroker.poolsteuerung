'use strict';

// 0.5.28: pH-Kalibrierung direkt in den normalen Instanzeinstellungen.
// Der Reiter wird aus admin/jsonConfigPhCalibration.json eingebunden.
// Dynamische Daten werden per sendTo + useNative geladen; alle UI-Schluessel
// beginnen mit '_' und werden deshalb nicht in native gespeichert.
const createBase = require('./main-ipadmini-final-527.js');

const VERSION = 'v0.5.28';
const HISTORY_ID = 'status.phCalibration.pointsHistoryJson';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const IDS = {
  fixedEnabled: 'status.phCalibration.fixedEnabled',
  fixedOffset: 'status.phCalibration.fixedOffset',
  fixedPoint: 'status.phCalibration.fixedPointJson',
  fixedSince: 'status.phCalibration.fixedSince',
  effectiveMode: 'status.phCalibration.effectiveMode',
  selectTrigger: 'control.ph.calibration.selectBestTrigger',
  clearTrigger: 'control.ph.calibration.clearFixedTrigger'
};

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 3) {
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

function fmt(value, digits = 2) {
  const parsed = num(value);
  return parsed === null ? '--' : parsed.toFixed(digits).replace('.', ',');
}

function signed(value, digits = 3) {
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
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
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

function parseHistory(value) {
  try {
    const source = typeof value === 'string' ? JSON.parse(value || '[]') : value;
    if (!Array.isArray(source)) return [];
    return source.map((point, index) => normalizePoint(point, index)).filter(Boolean);
  } catch {
    return [];
  }
}

function parsePoint(value) {
  try {
    const source = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    return normalizePoint(source, 0);
  } catch {
    return null;
  }
}

function analyze(points) {
  const valid = Array.isArray(points) ? points.filter(Boolean) : [];
  const med = median(valid.map(point => point.delta));
  const mad = med === null ? null : median(valid.map(point => Math.abs(point.delta - med)));
  let recommended = null;
  if (med !== null && valid.length) {
    recommended = valid.slice().sort((a, b) => {
      const da = Math.abs(a.delta - med);
      const db = Math.abs(b.delta - med);
      if (Math.abs(da - db) > 1e-9) return da - db;
      // Bei identischem Abstand bevorzugen wir den neueren realen Messpunkt.
      return (b.ts || 0) - (a.ts || 0) || b.index - a.index;
    })[0];
  }
  return { points: valid, median: med, mad, recommended };
}

function samePoint(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.raw - b.raw) < 0.0005 &&
    Math.abs(a.ref - b.ref) < 0.0005 &&
    Math.abs(a.delta - b.delta) < 0.0005 &&
    (!a.ts || !b.ts || Number(a.ts) === Number(b.ts));
}

function dateText(ts) {
  if (!Number(ts)) return '--';
  try {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(Number(ts)));
  } catch {
    return new Date(Number(ts)).toLocaleString('de-DE');
  }
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationAdmin528Installed) return adapter;
  adapter.__phCalibrationAdmin528Installed = true;

  async function getLocal(id) {
    try { return await adapter.getStateAsync(id); } catch { return null; }
  }

  async function getForeign(id) {
    try { return await adapter.getForeignStateAsync(id); } catch { return null; }
  }

  async function buildNative() {
    const [historyState, fixedEnabledState, fixedOffsetState, fixedPointState, fixedSinceState, modeState, rawState, outState] = await Promise.all([
      getLocal(HISTORY_ID),
      getLocal(IDS.fixedEnabled),
      getLocal(IDS.fixedOffset),
      getLocal(IDS.fixedPoint),
      getLocal(IDS.fixedSince),
      getLocal(IDS.effectiveMode),
      getForeign(RAW_ID),
      getForeign(OUT_ID)
    ]);

    const points = parseHistory(historyState && historyState.val);
    const result = analyze(points);
    const fixedEnabled = !!fixedEnabledState && boolValue(fixedEnabledState.val);
    const fixedOffset = fixedEnabled ? num(fixedOffsetState && fixedOffsetState.val) : null;
    const fixedPoint = fixedEnabled ? parsePoint(fixedPointState && fixedPointState.val) : null;
    const fixedSince = Number(fixedSinceState && fixedSinceState.val) || 0;
    const raw = num(rawState && rawState.val);
    const corrected = num(outState && outState.val);

    const history = result.points
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0) || b.index - a.index)
      .map(point => {
        const distance = result.median === null ? null : Math.abs(point.delta - result.median);
        const tags = [];
        if (fixedEnabled && fixedPoint && samePoint(point, fixedPoint)) tags.push('AKTIV');
        if (result.recommended && samePoint(point, result.recommended)) tags.push('EMPFOHLEN');
        if (!tags.length) {
          const limit = Math.max(0.10, (result.mad || 0) * 2);
          tags.push(distance !== null && distance > limit ? 'abweichend' : 'Historie');
        }
        return {
          date: dateText(point.ts),
          raw: fmt(point.raw, 2),
          ref: fmt(point.ref, 2),
          delta: `${signed(point.delta, 3)} pH`,
          distance: distance === null ? '--' : fmt(distance, 3),
          status: tags.join(' · ')
        };
      });

    const recommendedText = result.recommended
      ? `PH803W ${fmt(result.recommended.raw, 2)} → PoolLab ${fmt(result.recommended.ref, 2)} · Offset ${signed(result.recommended.delta, 3)} pH · ${dateText(result.recommended.ts)}`
      : 'Kein gültiger Vorschlag vorhanden';

    const fixedText = fixedEnabled && fixedPoint && fixedOffset !== null
      ? `PH803W ${fmt(fixedPoint.raw, 2)} → PoolLab ${fmt(fixedPoint.ref, 2)} · Offset ${signed(fixedOffset, 3)} pH · festgelegt ${dateText(fixedSince)}`
      : 'Kein Punkt festgelegt – der Adapter verwendet weiterhin den jeweils neuesten PoolLab-Kalibrierpunkt.';

    const modeText = fixedEnabled
      ? 'FEST · robuster historischer Kalibrierpunkt'
      : `AUTO · neuester Kalibrierpunkt${modeState && modeState.val ? ` · ${modeState.val}` : ''}`;

    const currentText = raw === null
      ? 'PH803W-Rohwert derzeit nicht verfügbar'
      : corrected === null
        ? `PH803W roh ${fmt(raw, 3)} pH`
        : fixedEnabled && fixedOffset !== null
          ? `${fmt(raw, 3)} + (${signed(fixedOffset, 3)}) = ${fmt(corrected, 3)} pH`
          : `PH803W roh ${fmt(raw, 3)} → korrigiert ${fmt(corrected, 3)} pH`;

    return {
      _calMode: modeText,
      _calCount: String(result.points.length),
      _calMedian: result.median === null ? '--' : `${signed(result.median, 3)} pH`,
      _calMad: result.mad === null ? '--' : `${fmt(result.mad, 3)} pH`,
      _calRecommended: recommendedText,
      _calFixed: fixedText,
      _calCurrent: currentText,
      _calHistory: history
    };
  }

  async function waitFor(check, timeoutMs = 3500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await check()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async function selectBestVia527() {
    const before = await getLocal(IDS.fixedSince);
    const beforeSince = Number(before && before.val) || 0;
    await adapter.setStateAsync(IDS.selectTrigger, true, false);
    const ok = await waitFor(async () => {
      const [enabled, since] = await Promise.all([getLocal(IDS.fixedEnabled), getLocal(IDS.fixedSince)]);
      return !!enabled && boolValue(enabled.val) && (Number(since && since.val) || 0) !== beforeSince;
    });
    if (!ok) throw new Error('Die Kalibrierlogik hat die Festlegung nicht innerhalb des Zeitlimits bestätigt.');
    return buildNative();
  }

  async function clearFixedVia527() {
    await adapter.setStateAsync(IDS.clearTrigger, true, false);
    const ok = await waitFor(async () => {
      const enabled = await getLocal(IDS.fixedEnabled);
      return !enabled || !boolValue(enabled.val);
    });
    if (!ok) throw new Error('Die Kalibrierlogik hat das Aufheben nicht innerhalb des Zeitlimits bestätigt.');
    return buildNative();
  }

  function reply(obj, payload) {
    if (!obj || !obj.callback || typeof adapter.sendTo !== 'function') return;
    adapter.sendTo(obj.from, obj.command, payload, obj.callback);
  }

  adapter.on('message', obj => {
    if (!obj || adapter.isShuttingDown) return;

    if (obj.command === 'phCalibrationAdminLoad') {
      buildNative()
        .then(native => reply(obj, { native }))
        .catch(error => reply(obj, { error: 'error', message: error.message || String(error) }));
      return;
    }

    if (obj.command === 'phCalibrationAdminSelect') {
      selectBestVia527()
        .then(native => reply(obj, { result: 'ok', native }))
        .catch(error => reply(obj, { error: 'error', message: error.message || String(error) }));
      return;
    }

    if (obj.command === 'phCalibrationAdminClear') {
      clearFixedVia527()
        .then(native => reply(obj, { result: 'cleared', native }))
        .catch(error => reply(obj, { error: 'error', message: error.message || String(error) }));
    }
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

'use strict';

const createBase = require('./main-ipadmini-final-057.js');

const VERSION = 'v0.4.58';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const POINTS_ID = 'status.phCalibration.pointsJson';
const BACKUP_ID = 'status.phCalibration.pointsBackupBefore058';
const MIGRATION_ID = 'status.phCalibration.migration058Done';
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

function clusterByDelta(points, tolerance = 0.10) {
  const sorted = [...points].sort((a, b) => a.delta - b.delta);
  const clusters = [];
  for (const point of sorted) {
    const cluster = clusters[clusters.length - 1];
    if (!cluster || Math.abs(point.delta - cluster[cluster.length - 1].delta) > tolerance) clusters.push([point]);
    else cluster.push(point);
  }
  return clusters;
}

function selectPlausiblePoints(points) {
  const normalized = normalizePoints(points);
  if (normalized.length < 2) return { points: normalized, changed: false, reason: '' };

  const deltas = normalized.map(point => point.delta);
  const span = Math.max(...deltas) - Math.min(...deltas);
  if (span < 0.15) return { points: normalized, changed: false, reason: '' };

  const chronological = [...normalized].sort((a, b) => a.ts - b.ts);
  const baselineDelta = chronological[0] && Number.isFinite(chronological[0].delta)
    ? chronological[0].delta
    : FALLBACK_DELTA;
  const clusters = clusterByDelta(normalized);
  clusters.sort((a, b) => {
    const meanA = a.reduce((sum, point) => sum + point.delta, 0) / a.length;
    const meanB = b.reduce((sum, point) => sum + point.delta, 0) / b.length;
    const distance = Math.abs(meanA - baselineDelta) - Math.abs(meanB - baselineDelta);
    return Math.abs(distance) > 0.0001 ? distance : b.length - a.length;
  });

  const selected = normalizePoints(clusters[0] || []);
  if (!selected.length || selected.length === normalized.length) return { points: normalized, changed: false, reason: '' };

  return {
    points: selected,
    changed: true,
    reason: `${normalized.length - selected.length} unplausible Kalibrierpunkt(e) entfernt; Offset-Spanne ${span.toFixed(3)}`
  };
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
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

async function migrateAndRecalculate(adapter) {
  await adapter.ensureState(BACKUP_ID, 'string', 'json', '', false);
  await adapter.ensureState(MIGRATION_ID, 'boolean', 'indicator', false, false);

  const migration = await adapter.getStateAsync(MIGRATION_ID);
  let pointsState = await adapter.getStateAsync(POINTS_ID);
  let originalText = String((pointsState && pointsState.val) || '[]');
  let points;
  try { points = normalizePoints(JSON.parse(originalText)); }
  catch { points = []; originalText = '[]'; }

  if (!(migration && migration.val === true)) {
    const result = selectPlausiblePoints(points);
    if (result.changed) {
      await adapter.setStateIfChanged(BACKUP_ID, originalText, true);
      points = result.points;
      await adapter.setStateIfChanged(POINTS_ID, JSON.stringify(points), true);
      await adapter.setStateIfChanged('status.phCalibration.count', points.length, true);
      adapter.__phCalibrationPoints = points;
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', `Kalibriertabelle repariert: ${result.reason}. Backup: ${adapter.namespace}.${BACKUP_ID}`, true);
      if (adapter.log && typeof adapter.log.warn === 'function') adapter.log.warn(`[PH-KAL] ${result.reason}.`);
    } else {
      adapter.__phCalibrationPoints = points;
    }
    await adapter.setStateIfChanged(MIGRATION_ID, true, true);
  }

  pointsState = await adapter.getStateAsync(POINTS_ID);
  try { points = normalizePoints(JSON.parse(String((pointsState && pointsState.val) || '[]'))); }
  catch { points = []; }
  adapter.__phCalibrationPoints = points;

  const rawState = await adapter.getForeignStateAsync(RAW_ID);
  const raw = num(rawState && rawState.val);
  if (raw === null) return;
  const corrected = calculate(raw, points);
  await adapter.setForeignStateAsync(OUT_ID, corrected, true);
  await adapter.setStateIfChanged('status.phCalibration.currentRaw', rnd(raw), true);
  await adapter.setStateIfChanged('status.phCalibration.currentCorrected', corrected, true);
  await adapter.setStateIfChanged('status.phCalibration.currentDelta', rnd(corrected - raw), true);
  adapter.__phPolling057LastRaw = null;
  adapter.__phPolling057LastCorrected = null;
  adapter.lastRenderSignature = '';
  adapter.lastRenderAt = 0;
  if (Object.prototype.hasOwnProperty.call(adapter, '__ipadLastFullRender056')) adapter.__ipadLastFullRender056 = 0;
  try { await adapter.forceImmediateRender(); } catch {}
}

function install(adapter) {
  if (!adapter || adapter.__phRepair058Installed) return adapter;
  adapter.__phRepair058Installed = true;

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
        await migrateAndRecalculate(adapter);
        if (adapter.log && typeof adapter.log.info === 'function') adapter.log.info(`[PH-KAL] ${VERSION}: Kalibriertabelle geprüft und pH neu berechnet`);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
          adapter.log.error('[PH-KAL] Reparatur 0.4.58 fehlgeschlagen: ' + (error.message || error));
        }
      }
    }, 8200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

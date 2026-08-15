'use strict';

// 0.5.58 backend cleanup. No VIS/layout changes.
// - filters corrupt pH calibration points (> +/-0.60 pH offset)
// - persists cleaned calibration JSON after ready
// - demotes expected startup/self-healing diagnostics from warn/error to info
// - relies on corrected 0.5.53 object lifecycle guard
const createBase = require('./main-ipadmini-final-557-fixed.js');

const VERSION = '0.5.58';
const POINTS_ID = 'status.phCalibration.pointsJson';
const HISTORY_ID = 'status.phCalibration.pointsHistoryJson';
const ACTIVE_ID = 'status.phCalibration.activePointJson';
const MAX_DELTA = 0.60;

function n(v) {
  if (v === undefined || v === null || v === '') return null;
  const x = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(x) ? x : null;
}

function validPoint(p) {
  if (!p || typeof p !== 'object') return false;
  const raw = n(p.raw);
  const ref = n(p.ref !== undefined ? p.ref : p.poollab);
  if (raw === null || ref === null || raw < 0 || raw > 14 || ref < 0 || ref > 14) return false;
  return Math.abs(ref - raw) <= MAX_DELTA;
}

function normalizePoint(p) {
  if (!validPoint(p)) return null;
  const raw = n(p.raw);
  const ref = n(p.ref !== undefined ? p.ref : p.poollab);
  const ts = Number(p.ts);
  return {
    raw: Math.round(raw * 1000) / 1000,
    ref: Math.round(ref * 1000) / 1000,
    delta: Math.round((ref - raw) * 1000) / 1000,
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now()
  };
}

function sanitizeJsonForId(id, value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || (id === ACTIVE_ID ? '{}' : '[]')) : value;
    if (id === ACTIVE_ID) {
      const p = normalizePoint(parsed);
      return JSON.stringify(p || {});
    }
    const arr = Array.isArray(parsed) ? parsed : [];
    const clean = arr.map(normalizePoint).filter(Boolean).sort((a,b) => a.ts - b.ts);
    return JSON.stringify(clean.slice(-100));
  } catch {
    return id === ACTIVE_ID ? '{}' : '[]';
  }
}

function install(adapter) {
  if (!adapter || adapter.__cleanup558Installed) return adapter;
  adapter.__cleanup558Installed = true;

  // Filter corrupt calibration data for all old calibration layers immediately.
  // The wrapper is installed before ready, while the actual DB access happens later.
  if (typeof adapter.getStateAsync === 'function') {
    const originalGetStateAsync = adapter.getStateAsync.bind(adapter);
    adapter.__originalGetStateAsync558 = originalGetStateAsync;
    adapter.getStateAsync = async function getStateAsync558(id, ...rest) {
      const st = await originalGetStateAsync(id, ...rest);
      if (!st || ![POINTS_ID, HISTORY_ID, ACTIVE_ID].includes(String(id))) return st;
      return { ...st, val: sanitizeJsonForId(String(id), st.val) };
    };
  }

  // Startup/self-healing messages are diagnostics, not operational warnings/errors.
  if (adapter.log) {
    const oldWarn = typeof adapter.log.warn === 'function' ? adapter.log.warn.bind(adapter.log) : null;
    const oldError = typeof adapter.log.error === 'function' ? adapter.log.error.bind(adapter.log) : null;
    const info = typeof adapter.log.info === 'function' ? adapter.log.info.bind(adapter.log) : null;

    if (oldWarn) {
      adapter.log.warn = function warn558(msg, ...args) {
        const t = String(msg || '');
        const expected =
          (t.includes('[CHLOR-HARDGUARD 0.5.25]') && t.includes('Bootstrap aktiv')) ||
          (t.includes('[CHLOR-OWNER]') && t.includes('aktiv: zentrale')) ||
          (t.includes('[CHLOR-OWNER 0.5.17]') && t.includes('unerwartet AUS; EIN wiederhergestellt'));
        if (expected && info) return info(t, ...args);
        return oldWarn(msg, ...args);
      };
    }

    if (oldError) {
      adapter.log.error = function error558(msg, ...args) {
        const t = String(msg || '');
        const expectedStartupWait = t.includes('[PH-STARTSCHUTZ 0.5.35]') &&
          (t.includes('VIS bleibt gesperrt') || t.includes('beim Start noch nicht plausibel verfügbar'));
        if (expectedStartupWait && info) return info(t, ...args);
        return oldError(msg, ...args);
      };
    }
  }

  async function persistCleanCalibration() {
    const rawGet = adapter.__originalGetStateAsync558 || adapter.getStateAsync.bind(adapter);
    for (const id of [POINTS_ID, HISTORY_ID, ACTIVE_ID]) {
      try {
        const st = await rawGet(id);
        if (!st) continue;
        const current = String(st.val ?? '');
        const clean = sanitizeJsonForId(id, current);
        if (clean !== current) {
          await adapter.setStateIfChanged(id, clean, true);
          if (adapter.log) adapter.log.info(`[PH-KAL ${VERSION}] beschädigte Kalibrierdaten bereinigt: ${id}`);
        }
      } catch (e) {
        if (adapter.log && adapter.config && adapter.config.debugMode) adapter.log.debug(`[PH-KAL ${VERSION}] Bereinigung ${id}: ${e.message || e}`);
      }
    }
  }

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(h);
      if (adapter.isShuttingDown) return;
      await persistCleanCalibration();
      if (adapter.log) adapter.log.info(`[CLEANUP] ${VERSION}: Backend-Bereinigung aktiv, VIS unverändert.`);
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

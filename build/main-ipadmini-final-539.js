'use strict';

// 0.5.39: pH-Automatik auf 30-Minuten-Pruefraster umstellen.
// Die bestehende Dosierlogik bleibt verantwortlich fuer Bedarf, Toleranz,
// Pumpenfreigabe, Maximaldauer je Dosis und Tageslimit. Diese Schicht ersetzt
// lediglich die wenigen festen pH-Pruefzeitpunkte durch ein durchgaengiges
// 30-Minuten-Raster und setzt die Sperrzeit nach einer Dosierung ebenfalls auf
// 30 Minuten. Dadurch gilt: pruefen -> bei Bedarf dosieren -> 30 min mischen ->
// erneut messen/pruefen. Es wird NICHT blind alle 30 Minuten dosiert.
const createBase = require('./main-ipadmini-final-538.js');

const VERSION = 'v0.5.39';
const DEBUG_ID = 'status.debug.ph30MinCycle539';
const CHECK_INTERVAL_MIN = 30;

function buildHalfHourTimes() {
  const times = [];
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 30]) {
      times.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }
  return times.join(',');
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__ph30MinCycle539Installed) return adapter;
  adapter.__ph30MinCycle539Installed = true;

  const effectiveCheckTimes = buildHalfHourTimes();
  const originalCheckTimes = String((adapter.config && adapter.config.phCheckTimes) || '');
  const originalLockMinutes = Number(adapter.config && adapter.config.phDoseLockMinutes);

  // Nur Laufzeitkonfiguration aendern. Die eigentlichen Sicherheits- und
  // Dosierparameter bleiben unveraendert. Bestehende Pumpen-/Freigabelogik
  // entscheidet weiterhin, ob an einem Pruefzeitpunkt dosiert werden darf.
  if (adapter.config) {
    adapter.config.phCheckTimes = effectiveCheckTimes;
    adapter.config.phDoseLockMinutes = CHECK_INTERVAL_MIN;
  }

  async function ensureDebug() {
    await adapter.setObjectNotExistsAsync(DEBUG_ID, {
      type: 'state',
      common: {
        name: 'pH 30-Minuten-Pruefraster 0.5.39',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: ''
      },
      native: {}
    });
  }

  async function updateDebug(reason) {
    try {
      await ensureDebug();
      const maxSec = Number(adapter.config && adapter.config.phDoseMaxDurationSec);
      const maxDay = Number(adapter.config && adapter.config.phDoseMaxPerDay);
      const flow = Number(adapter.config && adapter.config.phPumpFlowMlPerMin);
      const text =
        `AKTIV · ${reason} · Pruefung alle ${CHECK_INTERVAL_MIN} min · ` +
        `Sperrzeit ${CHECK_INTERVAL_MIN} min · Max je Dosis ${Number.isFinite(maxSec) ? maxSec : '--'} s · ` +
        `Max/Tag ${Number.isFinite(maxDay) ? maxDay : '--'} · ` +
        `Pumpe ${Number.isFinite(flow) ? flow : '--'} ml/min · ` +
        `vorher Pruefzeiten "${originalCheckTimes || '--'}" / Sperre ${Number.isFinite(originalLockMinutes) ? originalLockMinutes : '--'} min`;
      await adapter.setStateIfChanged(DEBUG_ID, text, true);
    } catch {}
  }

  // Falls eine tiefere Schicht die Konfiguration spaeter erneut einliest oder
  // veraendert, vor jedem Regelzyklus das gewollte Raster wieder sicherstellen.
  if (typeof adapter.applyControlLogic === 'function') {
    const originalApply = adapter.applyControlLogic.bind(adapter);
    adapter.applyControlLogic = async function applyControlLogic30Min539(...args) {
      if (adapter.config) {
        adapter.config.phCheckTimes = effectiveCheckTimes;
        adapter.config.phDoseLockMinutes = CHECK_INTERVAL_MIN;
      }
      return originalApply(...args);
    };
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      if (adapter.config) {
        adapter.config.phCheckTimes = effectiveCheckTimes;
        adapter.config.phDoseLockMinutes = CHECK_INTERVAL_MIN;
      }
      await updateDebug('ready');
    }, 200));
  });

  // Fallback fuer spaet geladene Wrapper-Schichten.
  const fallback = setTimeout(() => {
    if (adapter.isShuttingDown) return;
    if (adapter.config) {
      adapter.config.phCheckTimes = effectiveCheckTimes;
      adapter.config.phDoseLockMinutes = CHECK_INTERVAL_MIN;
    }
    updateDebug('fallback').catch(() => {});
  }, 1200);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(fallback);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

// 0.5.30: Komfortables Löschen markierter pH-Kalibrierpunkte.
// Die bewährte Einzel-Löschlogik aus 0.5.29 wird für alle markierten
// Tabellenzeilen wiederverwendet. Gelöscht wird von unten nach oben,
// damit die sichtbaren Zeilennummern während der Mehrfachauswahl stabil bleiben.
const createBase = require('./main-ipadmini-final-529.js');

const VERSION = 'v0.5.30';

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

function rowsFromMessage(message) {
  let payload = message;
  if (typeof payload === 'string') payload = parseJson(payload, payload);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) payload = payload.rows;
  if (typeof payload === 'string') payload = parseJson(payload, []);
  return Array.isArray(payload) ? payload : [];
}

function selectedRows(message) {
  const rows = rowsFromMessage(message);
  const selected = rows
    .filter(row => row && boolValue(row.selected))
    .map(row => Number(row.nr))
    .filter(row => Number.isInteger(row) && row >= 1);
  return {
    total: rows.length,
    selected: [...new Set(selected)].sort((a, b) => b - a)
  };
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationDelete530Installed) return adapter;
  adapter.__phCalibrationDelete530Installed = true;

  const originalSendTo = typeof adapter.sendTo === 'function' ? adapter.sendTo.bind(adapter) : null;

  // Checkbox am Zeilenanfang ergänzen. Die von 0.5.29 gelieferte stabile
  // Zeilennummer bleibt unsichtbar im Datensatz und dient als Löschschlüssel.
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

  function sendToSelf(command, message) {
    return new Promise((resolve, reject) => {
      if (!originalSendTo) {
        reject(new Error('Die ioBroker-Nachrichtenfunktion ist nicht verfügbar.'));
        return;
      }
      originalSendTo(adapter.namespace, command, message, response => {
        if (!response) {
          reject(new Error('Keine Antwort von der Kalibrierlogik erhalten.'));
          return;
        }
        if (response.error) {
          reject(new Error(response.message || String(response.error)));
          return;
        }
        resolve(response);
      });
    });
  }

  async function deleteMarked(message) {
    const selection = selectedRows(message);
    if (!selection.selected.length) throw new Error('Bitte zuerst mindestens eine Tabellenzeile markieren.');
    if (selection.total && selection.selected.length >= selection.total) {
      throw new Error('Mindestens ein Kalibrierpunkt muss erhalten bleiben. Bitte nicht alle Zeilen markieren.');
    }

    // Absteigend löschen: Wird z. B. Zeile 5 zuerst entfernt, bleiben die
    // Nummern der darüberliegenden Zeilen 1 bis 4 unverändert.
    for (const row of selection.selected) {
      await sendToSelf('phCalibrationAdminDeleteRow', { row });
    }

    return `${selection.selected.length} markierte Kalibrierzeile${selection.selected.length === 1 ? '' : 'n'} wurde${selection.selected.length === 1 ? '' : 'n'} gelöscht.`;
  }

  function reply(obj, payload) {
    if (!obj || !obj.callback || typeof adapter.sendTo !== 'function') return;
    adapter.sendTo(obj.from, obj.command, payload, obj.callback);
  }

  adapter.on('message', obj => {
    if (!obj || adapter.isShuttingDown || obj.command !== 'phCalibrationAdminDeleteSelected') return;
    deleteMarked(obj.message)
      .then(message => reply(obj, { result: 'deleted', message, reloadBrowser: true }))
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

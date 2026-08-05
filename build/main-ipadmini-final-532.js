'use strict';

// 0.5.32: pH-Kalibrierhistorie als echte Admin-Komponente.
// Die Auswahl wird direkt als JavaScript-Objekt an den atomaren Lösch-Handler
// aus 0.5.31 gesendet. Damit entfällt die fehlerhafte jsonData-Interpolation
// der dynamischen Tabelle, durch die gesetzte Checkboxen verloren gingen.
const createBase = require('./main-ipadmini-final-531.js');

const VERSION = 'v0.5.32';

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationAdmin532Installed) return adapter;
  adapter.__phCalibrationAdmin532Installed = true;

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

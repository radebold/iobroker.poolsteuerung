'use strict';

// 0.5.33: Korrektur des ioBroker-Custom-Component-Loadernamens.
// Der Loader erwartet RemoteName/Modul/Komponente. Die eigentliche
// Kalibrierlogik und der atomare Lösch-Handler aus 0.5.31 bleiben unverändert.
const createBase = require('./main-ipadmini-final-532.js');

const VERSION = 'v0.5.33';

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationAdmin533Installed) return adapter;
  adapter.__phCalibrationAdmin533Installed = true;

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

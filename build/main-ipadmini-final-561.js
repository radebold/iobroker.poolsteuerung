'use strict';

// 0.5.61: pH-Rohwert-Alterspruefung nur bei laufender Umwaelzpumpe.
// Die eigentliche Korrektur wird per postinstall direkt in der historischen
// 0.4.67-Kalibrierung vorgenommen. VIS und Regelungslogik bleiben unveraendert.
const createBase = require('./main-ipadmini-final-560.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

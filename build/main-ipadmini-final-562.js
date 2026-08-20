'use strict';

// 0.5.62: reine Kompatibilitaetsbereinigung fuer den historischen iPad-Mini-Fix 0.4.47.
// Die eigentliche Korrektur wird per postinstall direkt in 0.4.47 vorgenommen.
// VIS, Dosierbuttons und Regelungslogik bleiben unveraendert.
const createBase = require('./main-ipadmini-final-561.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

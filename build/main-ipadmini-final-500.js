'use strict';

// 0.5.19: Der historische 0.5.0-VIS-Updater wurde vollständig entfernt.
// Kompatibilitätsglied: nur die eigentliche Adapter-/VIS-Basis 0.4.71 weiterreichen.
const createBase = require('./main-ipadmini-final-071.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

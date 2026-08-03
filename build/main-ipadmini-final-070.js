'use strict';

// 0.5.19: Historische Update-/Refresh-Schicht entfernt.
// Nur die eigentliche VIS-Basis 0.4.69 weiterreichen.
const createBase = require('./main-ipadmini-final-069.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

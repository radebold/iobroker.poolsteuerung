'use strict';

// 0.5.19: Der 0.5.8-Einzel-Updater wurde vollständig entfernt.
// Keine GitHub-Prüfung, keine Update-Timer, keine VIS-Buttons, keine Installationshelper.
const createBase = require('./main-ipadmini-final-500.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

// 0.5.67: Sicherheits-Rollback der reinen VIS-Erweiterungen 0.5.64-0.5.66.
// Basis ist der zuletzt stabile 0.5.63-Pfad. Keine Aenderung an Regelung,
// pH-/Chlor-Logik oder Admin-UI. Ziel: vollstaendige Phone-VIS wiederherstellen.
const createBase = require('./main-ipadmini-final-563.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

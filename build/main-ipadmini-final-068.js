'use strict';

// 0.5.19: Der historische 0.4.68-Updater ist vollständig entfernt.
// Diese Datei bleibt nur als Kompatibilitätsglied der bestehenden Wrapper-Kette erhalten.
// Es werden keine Update-States überwacht, keine Timer angelegt, keine Helper gestartet
// und insbesondere keine Adapter-Neustarts ausgelöst.
const createBase = require('./main-ipadmini-final-067.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

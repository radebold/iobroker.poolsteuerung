'use strict';

// 0.5.9: fester neuer Einstiegspunkt auf die konsolidierte Einzel-Runtime.
// main-ipadmini-final-5082.js basiert direkt auf 0.5.0 und enthält genau einen Updater.
const createAdapter = require('./main-ipadmini-final-5082.js');

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

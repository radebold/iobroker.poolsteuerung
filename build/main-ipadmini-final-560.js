'use strict';

// 0.5.60: reiner Log-/Installations-Bereinigungsstand.
// Regelung, Alerts und VIS bleiben auf 0.5.59 unveraendert.
const createBase = require('./main-ipadmini-final-559.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

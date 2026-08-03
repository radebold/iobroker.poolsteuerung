'use strict';

// 0.5.19: Update-Button-Normalizer entfernt.
// Es existieren keine Update-Buttons mehr in der VIS.
const createBase = require('./main-ipadmini-final-5082.js');

function createAdapter(options = {}) {
  return createBase(options);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

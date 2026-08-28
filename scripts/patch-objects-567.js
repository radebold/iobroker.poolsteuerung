'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

// Nur die bis 0.5.63 benoetigten Objekt-/Kompatibilitaetspatches anwenden.
require('./patch-objects-563.js');

const ioFile = path.join(root, 'io-package.json');
const io = JSON.parse(fs.readFileSync(ioFile, 'utf8'));
io.version = '0.5.67';
io.common = io.common || {};
io.common.version = '0.5.67';
fs.writeFileSync(ioFile, JSON.stringify(io, null, 2) + '\n');
console.log('[0.5.67] VIS-Rollback auf stabilen 0.5.63-Pfad; 0.5.64-0.5.66 Layoutpatches deaktiviert');

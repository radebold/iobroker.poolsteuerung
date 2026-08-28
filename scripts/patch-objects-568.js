'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

// Nur stabile Objekt-/Kompatibilitaetspatches bis 0.5.63/0.5.67.
require('./patch-objects-567.js');

const ioFile = path.join(root, 'io-package.json');
const io = JSON.parse(fs.readFileSync(ioFile, 'utf8'));
io.version = '0.5.68';
io.common = io.common || {};
io.common.version = '0.5.68';
fs.writeFileSync(ioFile, JSON.stringify(io, null, 2) + '\n');
console.log('[0.5.68] Phone-Builder: PH-Info rechts + 24h-Pooltemperaturkurve; Abmessungen unveraendert');

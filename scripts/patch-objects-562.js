'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');

// Alle bisherigen Patches beibehalten.
require('./patch-objects-561.js');

// 0.4.47 ist im Repository bereits direkt korrigiert.
// Hier keine fragile Quelltextsuche/-ersetzung mehr durchführen.
const ioFile=path.join(root,'io-package.json');
const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.62';
io.common=io.common||{};
io.common.version='0.5.62';
fs.writeFileSync(ioFile,JSON.stringify(io,null,2)+'\n');

console.log('[0.5.62] Legacy-iPad-Validierung ist direkt im Quellcode korrigiert; io-package auf 0.5.62 gesetzt');

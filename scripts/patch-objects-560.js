'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const ioFile = path.join(root, 'io-package.json');
const io = JSON.parse(fs.readFileSync(ioFile, 'utf8'));

io.version = '0.5.60';
io.common = io.common || {};
io.common.version = '0.5.60';
io.instanceObjects = Array.isArray(io.instanceObjects) ? io.instanceObjects : [];

function upsert(obj) {
  const i = io.instanceObjects.findIndex(x => x && x._id === obj._id);
  if (i >= 0) io.instanceObjects[i] = obj;
  else io.instanceObjects.push(obj);
}

const defs = [
  ['status.phCalibration.lastPollTs', 'Zeitstempel letzte pH-Kalibrierungsabfrage', 'number', 'value.time', 0],
  ['status.phCalibration.poolRaw', 'Pool pH Rohwert fuer Kalibrierung', 'number', 'value.ph', 0, 'pH'],
  ['status.phCalibration.poolCorrected', 'Pool pH korrigierter Wert fuer Kalibrierung', 'number', 'value.ph', 0, 'pH'],
  ['status.phCalibration.pollRaw', 'pH Poll Rohwert', 'number', 'value.ph', 0, 'pH'],
  ['status.phCalibration.pollCorrected', 'pH Poll korrigierter Wert', 'number', 'value.ph', 0, 'pH'],
  ['status.phCalibration.autoDoseBlocked', 'Automatische pH-Dosierung blockiert', 'boolean', 'indicator', false],
  ['status.phCalibration.autoDoseBlockReason', 'Grund der pH-Dosiersperre', 'string', 'text', '']
];

for (const [id, name, type, role, def, unit] of defs) {
  const common = { name, type, role, read: true, write: false, def };
  if (unit) common.unit = unit;
  upsert({ _id: id, type: 'state', common, native: {} });
}
fs.writeFileSync(ioFile, JSON.stringify(io, null, 2) + '\n');

function replaceLogLevel(rel, needles) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.warn('[0.5.60] Datei fehlt: ' + rel);
    return;
  }
  let src = fs.readFileSync(file, 'utf8');
  let changed = 0;
  for (const needle of needles) {
    const warnText = 'adapter.log.warn(' + needle;
    const infoText = 'adapter.log.info(' + needle;
    if (src.includes(warnText)) {
      src = src.split(warnText).join(infoText);
      changed++;
    }
  }
  if (changed) {
    fs.writeFileSync(file, src);
    console.log('[0.5.60] ' + rel + ': ' + changed + ' normale Diagnose-Logs auf info gesetzt');
  } else {
    console.log('[0.5.60] ' + rel + ': keine Aenderung erforderlich');
  }
}

replaceLogLevel('build/main-ipadmini-final-517.js', [
  "'[CHLOR-OWNER] v0.5.17 aktiv:",
  '`[CHLOR-OWNER 0.5.17] AUS-Befehl blockiert',
  '`[CHLOR-OWNER 0.5.17] Chlorinator unerwartet AUS; EIN wiederhergestellt'
]);
replaceLogLevel('build/main-ipadmini-final-524.js', [
  '`[CHLOR-HARDGUARD 0.5.24] ZbSend Power:0 blockiert'
]);
replaceLogLevel('build/main-ipadmini-final-525.js', [
  '`[CHLOR-HARDGUARD 0.5.25] Bootstrap aktiv'
]);

console.log('[0.5.60] pH-Objekte definiert; normale Chlor-Schutzdiagnosen sind info, echte Fehler bleiben warn/error');

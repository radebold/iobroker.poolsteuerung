'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const ioPackageFile = path.join(root, 'io-package.json');
const adminFile = path.join(root, 'admin', 'jsonConfig.json');

function upsertInstanceObject(list, object) {
  const index = list.findIndex(item => item && item._id === object._id);
  if (index >= 0) list[index] = object;
  else list.push(object);
}

function patchIoPackage() {
  const cfg = JSON.parse(fs.readFileSync(ioPackageFile, 'utf8'));
  cfg.version = '0.5.49';
  cfg.common = cfg.common || {};
  cfg.common.version = '0.5.49';
  cfg.native = cfg.native || {};
  if (!cfg.native.nightlyAutoResetTime) cfg.native.nightlyAutoResetTime = '22:00';
  cfg.instanceObjects = Array.isArray(cfg.instanceObjects) ? cfg.instanceObjects : [];

  upsertInstanceObject(cfg.instanceObjects, {
    _id: 'status.phCalibration.lastPollTs',
    type: 'state',
    common: { name: 'Zeitstempel letzte pH-Kalibrierungsabfrage', type: 'number', role: 'value.time', read: true, write: false, def: 0 },
    native: {}
  });
  upsertInstanceObject(cfg.instanceObjects, {
    _id: 'status.phCalibration.poolRaw',
    type: 'state',
    common: { name: 'Pool pH Rohwert für Kalibrierung', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: false, def: 0 },
    native: {}
  });
  upsertInstanceObject(cfg.instanceObjects, {
    _id: 'status.phCalibration.poolCorrected',
    type: 'state',
    common: { name: 'Pool pH korrigierter Wert für Kalibrierung', type: 'number', role: 'value.ph', unit: 'pH', read: true, write: false, def: 0 },
    native: {}
  });

  fs.writeFileSync(ioPackageFile, JSON.stringify(cfg, null, 2) + '\n');
}

function patchAdmin() {
  const cfg = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
  if (!cfg.items || !cfg.items.general || !cfg.items.general.items) return;
  const old = cfg.items.general.items;
  delete old.nightlyAutoResetTime;
  delete old.nightlyAutoResetInfo;
  const rebuilt = {};
  for (const [key, value] of Object.entries(old)) {
    rebuilt[key] = value;
    if (key === 'standbyPumpDurationSec') {
      rebuilt.nightlyAutoResetTime = {
        type: 'text', label: 'Uhrzeit Nacht-Reset (HH:MM)', newLine: true,
        sm: 12, md: 6, lg: 6, placeholder: '22:00',
        help: 'Bei aktiviertem VIS-Flag werden zu dieser Uhrzeit zuerst alle vier Poolgeräte ausgeschaltet und danach die vier Automatikschalter wieder aktiviert. Bei aktivem Standby wird der Vorgang komplett übersprungen.'
      };
      rebuilt.nightlyAutoResetInfo = {
        type: 'staticText',
        text: 'Der Nacht-Reset wird in allen Pool-VIS über den Flag-Schalter aktiviert oder deaktiviert. Standardzeit: 22:00 Uhr.',
        newLine: false, sm: 12, md: 6, lg: 6
      };
    }
  }
  cfg.items.general.items = rebuilt;
  fs.writeFileSync(adminFile, JSON.stringify(cfg, null, 2) + '\n');
}

patchIoPackage();
patchAdmin();
console.log('[0.5.49] io-package objects and ALLGEMEIN admin settings repaired.');

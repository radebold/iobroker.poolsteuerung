'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const adminFile = path.join(root, 'admin', 'jsonConfig.json');
const ioPackageFile = path.join(root, 'io-package.json');

function patchAdmin() {
  const cfg = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
  if (!cfg.items || !cfg.items.general || !cfg.items.general.items) {
    throw new Error('ALLGEMEIN-Bereich in admin/jsonConfig.json nicht gefunden');
  }

  const items = cfg.items.general.items;
  const rebuilt = {};
  for (const [key, value] of Object.entries(items)) {
    rebuilt[key] = value;
    if (key === 'standbyPumpDurationSec') {
      rebuilt.nightlyAutoResetTime = {
        type: 'text',
        label: 'Uhrzeit Nacht-Reset (HH:MM)',
        newLine: true,
        sm: 12,
        md: 6,
        lg: 6,
        placeholder: '22:00',
        help: 'Bei aktiviertem VIS-Flag werden zu dieser Uhrzeit zuerst alle vier Poolgeräte ausgeschaltet und danach die vier Automatikschalter wieder aktiviert. Bei aktivem Standby wird der Vorgang komplett übersprungen.'
      };
      rebuilt.nightlyAutoResetInfo = {
        type: 'staticText',
        text: 'Der Nacht-Reset wird in allen Pool-VIS über den Flag-Schalter aktiviert oder deaktiviert. Standardzeit: 22:00 Uhr.',
        newLine: false,
        sm: 12,
        md: 6,
        lg: 6
      };
    }
  }
  cfg.items.general.items = rebuilt;
  fs.writeFileSync(adminFile, JSON.stringify(cfg, null, 2) + '\n');
}

function patchIoPackage() {
  const cfg = JSON.parse(fs.readFileSync(ioPackageFile, 'utf8'));
  cfg.version = '0.5.48';
  if (cfg.common) cfg.common.version = '0.5.48';
  cfg.native = cfg.native || {};
  if (!cfg.native.nightlyAutoResetTime) cfg.native.nightlyAutoResetTime = '22:00';
  fs.writeFileSync(ioPackageFile, JSON.stringify(cfg, null, 2) + '\n');
}

patchAdmin();
patchIoPackage();
console.log('[0.5.48] Admin Nacht-Reset in ALLGEMEIN und io-package aktualisiert.');

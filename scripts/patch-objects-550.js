'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const ioPackageFile = path.join(root, 'io-package.json');
const adminFile = path.join(root, 'admin', 'jsonConfig.json');

function upsert(list, object) {
  const i = list.findIndex(x => x && x._id === object._id);
  if (i >= 0) list[i] = object; else list.push(object);
}

const io = JSON.parse(fs.readFileSync(ioPackageFile, 'utf8'));
io.version = '0.5.50';
io.common = io.common || {};
io.common.version = '0.5.50';
io.native = io.native || {};
if (!io.native.nightlyAutoResetTime) io.native.nightlyAutoResetTime = '22:00';
io.instanceObjects = Array.isArray(io.instanceObjects) ? io.instanceObjects : [];
upsert(io.instanceObjects,{_id:'status.phCalibration.lastPollTs',type:'state',common:{name:'Zeitstempel letzte pH-Kalibrierungsabfrage',type:'number',role:'value.time',read:true,write:false,def:0},native:{}});
upsert(io.instanceObjects,{_id:'status.phCalibration.poolRaw',type:'state',common:{name:'Pool pH Rohwert für Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}});
upsert(io.instanceObjects,{_id:'status.phCalibration.poolCorrected',type:'state',common:{name:'Pool pH korrigierter Wert für Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}});
upsert(io.instanceObjects,{_id:'control.nightlyAutoResetEnabled',type:'state',common:{name:'Nächtlicher Automatik-Reset',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
upsert(io.instanceObjects,{_id:'status.nightlyAutoReset.lastRun',type:'state',common:{name:'Letzter nächtlicher Automatik-Reset',type:'string',role:'text',read:true,write:false,def:''},native:{}});
fs.writeFileSync(ioPackageFile, JSON.stringify(io,null,2)+'\n');

const admin = JSON.parse(fs.readFileSync(adminFile,'utf8'));
if (admin.items && admin.items.general && admin.items.general.items) {
  const old = admin.items.general.items;
  delete old.nightlyAutoResetTime;
  delete old.nightlyAutoResetInfo;
  const rebuilt = {};
  for (const [key,val] of Object.entries(old)) {
    rebuilt[key]=val;
    if (key==='standbyPumpDurationSec') {
      rebuilt.nightlyAutoResetTime={type:'text',label:'Uhrzeit Nacht-Reset (HH:MM)',newLine:true,sm:12,md:6,lg:6,placeholder:'22:00',help:'Bei aktiviertem Nacht-Reset werden zu dieser Uhrzeit zuerst alle vier Poolgeräte ausgeschaltet und danach die vier Automatikschalter wieder aktiviert. Bei aktivem Standby wird der Vorgang übersprungen.'};
      rebuilt.nightlyAutoResetInfo={type:'staticText',text:'Aktivierung erfolgt über control.nightlyAutoResetEnabled. Standardzeit: 22:00 Uhr.',newLine:false,sm:12,md:6,lg:6};
    }
  }
  admin.items.general.items = rebuilt;
  fs.writeFileSync(adminFile,JSON.stringify(admin,null,2)+'\n');
}
console.log('[0.5.50] Stable VIS base + metadata repaired.');

'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const ioFile=path.join(root,'io-package.json');
const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.59';
io.common=io.common||{};
io.common.version='0.5.59';
io.instanceObjects=Array.isArray(io.instanceObjects)?io.instanceObjects:[];
function upsert(obj){const i=io.instanceObjects.findIndex(x=>x&&x._id===obj._id);if(i>=0)io.instanceObjects[i]=obj;else io.instanceObjects.push(obj);}
const defs=[
  ['status.phCalibration.lastPollTs','Zeitstempel letzte pH-Kalibrierungsabfrage','number','value.time',0],
  ['status.phCalibration.poolRaw','Pool pH Rohwert fuer Kalibrierung','number','value.ph',0,'pH'],
  ['status.phCalibration.poolCorrected','Pool pH korrigierter Wert fuer Kalibrierung','number','value.ph',0,'pH'],
  ['status.phCalibration.pollRaw','pH Poll Rohwert','number','value.ph',0,'pH'],
  ['status.phCalibration.pollCorrected','pH Poll korrigierter Wert','number','value.ph',0,'pH'],
  ['status.phCalibration.autoDoseBlocked','Automatische pH-Dosierung blockiert','boolean','indicator',false],
  ['status.phCalibration.autoDoseBlockReason','Grund der pH-Dosiersperre','string','text','']
];
for(const [id,name,type,role,def,unit] of defs){const common={name,type,role,read:true,write:false,def};if(unit)common.unit=unit;upsert({_id:id,type:'state',common,native:{}});}
fs.writeFileSync(ioFile,JSON.stringify(io,null,2)+'\n');
console.log('[0.5.59] pH-Poll-/Kalibrierungsobjekte fest definiert');

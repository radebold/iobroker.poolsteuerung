'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const ioFile=path.join(root,'io-package.json');
const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.53';
io.common=io.common||{};
io.common.version='0.5.53';
io.native=io.native||{};
if(!io.native.nightlyAutoResetTime) io.native.nightlyAutoResetTime='22:00';
io.instanceObjects=Array.isArray(io.instanceObjects)?io.instanceObjects:[];
function upsert(obj){const i=io.instanceObjects.findIndex(x=>x&&x._id===obj._id);if(i>=0)io.instanceObjects[i]=obj;else io.instanceObjects.push(obj);}
upsert({_id:'status.phCalibration.lastPollTs',type:'state',common:{name:'Zeitstempel letzte pH-Kalibrierungsabfrage',type:'number',role:'value.time',read:true,write:false,def:0},native:{}});
upsert({_id:'status.phCalibration.poolRaw',type:'state',common:{name:'Pool pH Rohwert fuer Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}});
upsert({_id:'status.phCalibration.poolCorrected',type:'state',common:{name:'Pool pH korrigierter Wert fuer Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}});
fs.writeFileSync(ioFile,JSON.stringify(io,null,2)+'\n');
console.log('[0.5.53] metadata and pH calibration instanceObjects updated');

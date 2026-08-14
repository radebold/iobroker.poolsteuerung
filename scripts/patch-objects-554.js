'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const ioFile=path.join(root,'io-package.json');
const adminFile=path.join(root,'admin','jsonConfig.json');

const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.54';
io.common=io.common||{};
io.common.version='0.5.54';
io.native=io.native||{};
if(typeof io.native.nightlyAutoResetEnabled!=='boolean') io.native.nightlyAutoResetEnabled=false;
if(!io.native.nightlyAutoResetTime) io.native.nightlyAutoResetTime='22:00';
io.instanceObjects=Array.isArray(io.instanceObjects)?io.instanceObjects:[];
function upsert(obj){const i=io.instanceObjects.findIndex(x=>x&&x._id===obj._id);if(i>=0)io.instanceObjects[i]=obj;else io.instanceObjects.push(obj);}
upsert({_id:'status.phCalibration.lastPollTs',type:'state',common:{name:'Zeitstempel letzte pH-Kalibrierungsabfrage',type:'number',role:'value.time',read:true,write:false,def:0},native:{}});
upsert({_id:'status.phCalibration.poolRaw',type:'state',common:{name:'Pool pH Rohwert fuer Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}});
upsert({_id:'status.phCalibration.poolCorrected',type:'state',common:{name:'Pool pH korrigierter Wert fuer Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}});
upsert({_id:'control.nightlyAutoResetEnabled',type:'state',common:{name:'Naechtlicher Automatik-Reset aktiv',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
upsert({_id:'status.nightlyAutoReset.lastRun',type:'state',common:{name:'Letzter naechtlicher Automatik-Reset',type:'string',role:'text',read:true,write:false,def:''},native:{}});
fs.writeFileSync(ioFile,JSON.stringify(io,null,2)+'\n');

const cfg=JSON.parse(fs.readFileSync(adminFile,'utf8'));
if(cfg.items&&cfg.items.general&&cfg.items.general.items){
  const old=cfg.items.general.items;
  delete old.nightlyAutoResetEnabled;
  delete old.nightlyAutoResetTime;
  delete old.nightlyAutoResetInfo;
  const n={};
  for(const [k,v] of Object.entries(old)){
    n[k]=v;
    if(k==='standbyPumpDurationSec'){
      n.nightlyAutoResetEnabled={
        type:'checkbox',
        label:'Nächtlichen Automatik-Reset aktiv',
        newLine:true,
        sm:12,md:6,lg:6,
        help:'Wenn aktiv, werden zur konfigurierten Uhrzeit zuerst alle vier Poolgeräte ausgeschaltet und anschließend die vier Automatikschalter wieder aktiviert. Bei aktivem Standby wird der Vorgang übersprungen.'
      };
      n.nightlyAutoResetTime={
        type:'text',
        label:'Uhrzeit Nacht-Reset (HH:MM)',
        newLine:false,
        sm:12,md:6,lg:6,
        placeholder:'22:00',
        hidden:'data.nightlyAutoResetEnabled === false',
        help:'Der Reset wird ab dieser Uhrzeit einmal pro Kalendertag ausgeführt. Wurde der exakte Zeitpunkt wegen eines Neustarts verpasst, wird er später am selben Tag nachgeholt.'
      };
    }
  }
  cfg.items.general.items=n;
  fs.writeFileSync(adminFile,JSON.stringify(cfg,null,2)+'\n');
}
console.log('[0.5.54] Admin-Flag Nacht-Reset und Metadaten aktualisiert');

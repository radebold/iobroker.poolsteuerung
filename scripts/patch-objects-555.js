'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const ioFile=path.join(root,'io-package.json');
const adminFile=path.join(root,'admin','jsonConfig.json');

const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.55';
io.common=io.common||{};
io.common.version='0.5.55';
io.native=io.native||{};
if(typeof io.native.nightlyAutoResetEnabled!=='boolean') io.native.nightlyAutoResetEnabled=false;
if(!io.native.nightlyAutoResetTime) io.native.nightlyAutoResetTime='22:00';
if(!io.native.waterLevelSensorStateId) io.native.waterLevelSensorStateId='sonoff.0.TasmotaZB.ZbReceived_0xD61C_ZoneStatusChange';
if(typeof io.native.alertOnLowWaterLevel!=='boolean') io.native.alertOnLowWaterLevel=true;
io.instanceObjects=Array.isArray(io.instanceObjects)?io.instanceObjects:[];
function upsert(obj){const i=io.instanceObjects.findIndex(x=>x&&x._id===obj._id);if(i>=0)io.instanceObjects[i]=obj;else io.instanceObjects.push(obj);}
upsert({_id:'status.phCalibration.lastPollTs',type:'state',common:{name:'Zeitstempel letzte pH-Kalibrierungsabfrage',type:'number',role:'value.time',read:true,write:false,def:0},native:{}});
upsert({_id:'status.phCalibration.poolRaw',type:'state',common:{name:'Pool pH Rohwert fuer Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}});
upsert({_id:'status.phCalibration.poolCorrected',type:'state',common:{name:'Pool pH korrigierter Wert fuer Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}});
upsert({_id:'control.nightlyAutoResetEnabled',type:'state',common:{name:'Naechtlicher Automatik-Reset aktiv',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
upsert({_id:'status.nightlyAutoReset.lastRun',type:'state',common:{name:'Letzter naechtlicher Automatik-Reset',type:'string',role:'text',read:true,write:false,def:''},native:{}});
upsert({_id:'status.waterLevel.low',type:'state',common:{name:'Pool Wasserstand zu niedrig',type:'boolean',role:'indicator.alarm',read:true,write:false,def:false},native:{}});
upsert({_id:'status.waterLevel.sensorValue',type:'state',common:{name:'Pool Wasserstand Sensorwert',type:'number',role:'value',read:true,write:false,def:0},native:{}});
upsert({_id:'status.waterLevel.lastAlert',type:'state',common:{name:'Letzte Wasserstandsmeldung',type:'string',role:'text',read:true,write:false,def:''},native:{}});
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
      n.nightlyAutoResetEnabled={type:'checkbox',label:'Nächtlichen Automatik-Reset aktiv',newLine:true,sm:12,md:6,lg:6,help:'Wenn aktiv, werden zur konfigurierten Uhrzeit zuerst alle vier Poolgeräte ausgeschaltet und anschließend die vier Automatikschalter wieder aktiviert. Bei aktivem Standby wird der Vorgang übersprungen.'};
      n.nightlyAutoResetTime={type:'text',label:'Uhrzeit Nacht-Reset (HH:MM)',newLine:false,sm:12,md:6,lg:6,placeholder:'22:00',hidden:'data.nightlyAutoResetEnabled === false',help:'Der Reset wird ab dieser Uhrzeit einmal pro Kalendertag ausgeführt. Wurde der exakte Zeitpunkt wegen eines Neustarts verpasst, wird er später am selben Tag nachgeholt.'};
    }
  }
  cfg.items.general.items=n;
}

if(cfg.items&&cfg.items.alerts&&cfg.items.alerts.items){
  const old=cfg.items.alerts.items;
  delete old.waterLevelSensorStateId;
  delete old.alertOnLowWaterLevel;
  delete old.waterLevelAlertInfo;
  const n={};
  for(const [k,v] of Object.entries(old)){
    n[k]=v;
    if(k==='alertOnSensorError'){
      n.alertOnLowWaterLevel={
        type:'checkbox',
        label:'Bei zu niedrigem Pool-Wasserstand',
        newLine:true,
        sm:12,md:6,lg:6,
        help:'Alarm wenn der konfigurierte Wasserstandssensor den Wert 0 meldet. Bei Rückkehr auf einen Wert ungleich 0 wird einmalig Entwarnung gesendet.'
      };
      n.waterLevelSensorStateId={
        type:'objectId',
        label:'State-ID Wasserstandssensor',
        objectTypes:['state'],
        newLine:true,
        sm:12,md:12,lg:12,
        hidden:'data.alertOnLowWaterLevel !== true',
        help:'Standard: sonoff.0.TasmotaZB.ZbReceived_0xD61C_ZoneStatusChange. Wert 0 bedeutet Wasserstand zu niedrig.'
      };
      n.waterLevelAlertInfo={
        type:'staticText',
        text:'Wasserstand: 0 = zu niedrig / Alarm, jeder andere numerische Wert = OK. Die vorhandene Wiederholsperre und die konfigurierten WhatsApp-, Telegram- oder E-Mail-Kanäle werden verwendet.',
        newLine:true,sm:12
      };
    }
  }
  cfg.items.alerts.items=n;
}

fs.writeFileSync(adminFile,JSON.stringify(cfg,null,2)+'\n');
console.log('[0.5.55] Wasserstandsalarm und Admin-Einstellungen aktualisiert');

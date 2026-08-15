'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const ioFile=path.join(root,'io-package.json');
const adminFile=path.join(root,'admin','jsonConfig.json');

const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.56';
io.common=io.common||{};
io.common.version='0.5.56';
io.native=io.native||{};
if(typeof io.native.alertLowWaterLevelText!=='string'||!io.native.alertLowWaterLevelText.trim()) io.native.alertLowWaterLevelText='Poolsteuerung: Wasserstand zu niedrig! Bitte Pool-Wasserstand prüfen.';
if(typeof io.native.alertWaterLevelOkText!=='string'||!io.native.alertWaterLevelOkText.trim()) io.native.alertWaterLevelOkText='Poolsteuerung: Wasserstand wieder OK.';
fs.writeFileSync(ioFile,JSON.stringify(io,null,2)+'\n');

const cfg=JSON.parse(fs.readFileSync(adminFile,'utf8'));
if(cfg.items&&cfg.items.alerts&&cfg.items.alerts.items){
  const old=cfg.items.alerts.items;
  delete old.alertLowWaterLevelText;
  delete old.alertWaterLevelOkText;
  delete old.waterLevelTemplateHelp;
  const n={};
  for(const [k,v] of Object.entries(old)){
    n[k]=v;
    if(k==='waterLevelSensorStateId'){
      n.alertLowWaterLevelText={
        type:'text',label:'Text bei Wasserstand zu niedrig',newLine:true,sm:12,md:12,lg:12,
        hidden:'data.alertOnLowWaterLevel !== true',
        help:'Variablen: {value}, {stateId}, {date}, {time}, {datetime}, {status}'
      };
      n.alertWaterLevelOkText={
        type:'text',label:'Text bei Wasserstand wieder OK',newLine:true,sm:12,md:12,lg:12,
        hidden:'data.alertOnLowWaterLevel !== true',
        help:'Variablen: {value}, {stateId}, {date}, {time}, {datetime}, {status}'
      };
      n.waterLevelTemplateHelp={
        type:'staticText',
        text:'Verfügbare Variablen: {value} = Sensorwert, {stateId} = State-ID, {date} = Datum, {time} = Uhrzeit, {datetime} = Datum + Uhrzeit, {status} = „zu niedrig“ oder „OK“. Variablen sind optional.',
        newLine:true,sm:12,md:12,lg:12,
        hidden:'data.alertOnLowWaterLevel !== true'
      };
    }
  }
  cfg.items.alerts.items=n;
  fs.writeFileSync(adminFile,JSON.stringify(cfg,null,2)+'\n');
}
console.log('[0.5.56] Wasserstand-Alerttexte und Variablen ergänzt');

'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const ioFile=path.join(root,'io-package.json');
const adminFile=path.join(root,'admin','jsonConfig.json');

const defaults={
  alertOnLowWaterLevel:false,
  waterLevelSensorStateId:'sonoff.0.TasmotaZB.ZbReceived_0xD61C_ZoneStatusChange',
  alertTextPhDoseStarted:'Poolsteuerung: pH-Dosierung gestartet · pH {ph} · Laufzeit {duration}s · ca. {ml} ml.',
  alertTextPhDoseStopped:'Poolsteuerung: pH-Dosierung beendet · Laufzeit {duration}s · ca. {ml} ml.',
  alertTextPhDoseAborted:'Poolsteuerung: pH-Dosierung abgebrochen · Grund: {reason}.',
  alertTextPhDailyLimit:'Poolsteuerung: Tageslimit pH-Dosierung erreicht ({dailyCount}/{dailyMax}).',
  alertTextSensorError:'Poolsteuerung: pH-Sensorwert ist ungültig oder fehlt. Bitte Sensor prüfen.',
  alertTextPollError:'Poolsteuerung: Poll-Fehler · {reason}',
  alertTextStartupError:'Poolsteuerung: Startfehler · {reason}',
  alertLowWaterLevelText:'Poolsteuerung: Wasserstand zu niedrig! Bitte Pool-Wasserstand prüfen.',
  alertWaterLevelOkText:'Poolsteuerung: Wasserstand wieder OK.',
  alertRepeatPhDoseStarted:'change',
  alertRepeatPhDoseStopped:'change',
  alertRepeatPhDoseAborted:'change',
  alertRepeatPhDailyLimit:'change',
  alertRepeatSensorError:'change',
  alertRepeatPollError:'change',
  alertRepeatLowWaterLevel:'change'
};

const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.57';
io.common=io.common||{};io.common.version='0.5.57';
io.native=io.native||{};
for(const [k,v] of Object.entries(defaults)){
  if(io.native[k]===undefined||io.native[k]===null||io.native[k]==='')io.native[k]=v;
}
io.instanceObjects=Array.isArray(io.instanceObjects)?io.instanceObjects:[];
function upsert(obj){const i=io.instanceObjects.findIndex(x=>x&&x._id===obj._id);if(i>=0)io.instanceObjects[i]=obj;else io.instanceObjects.push(obj);}
upsert({_id:'status.waterLevel.low',type:'state',common:{name:'Pool Wasserstand zu niedrig',type:'boolean',role:'indicator.alarm',read:true,write:false,def:false},native:{}});
upsert({_id:'status.waterLevel.sensorValue',type:'state',common:{name:'Pool Wasserstand Sensorwert',type:'number',role:'value',read:true,write:false,def:0},native:{}});
upsert({_id:'status.waterLevel.lastAlert',type:'state',common:{name:'Letzte Wasserstandsmeldung',type:'string',role:'text',read:true,write:false,def:''},native:{}});
fs.writeFileSync(ioFile,JSON.stringify(io,null,2)+'\n');

const cfg=JSON.parse(fs.readFileSync(adminFile,'utf8'));
if(cfg.items&&cfg.items.alerts&&cfg.items.alerts.items){
  const old=cfg.items.alerts.items;
  const remove=[
    'alertRepeatLockMin','alertTemplateHelp','alertVariableHelp',
    'alertTextPhDoseStarted','alertRepeatPhDoseStarted','helpPhDoseStarted',
    'alertTextPhDoseStopped','alertRepeatPhDoseStopped','helpPhDoseStopped',
    'alertTextPhDoseAborted','alertRepeatPhDoseAborted','helpPhDoseAborted',
    'alertTextPhDailyLimit','alertRepeatPhDailyLimit','helpPhDailyLimit',
    'alertTextSensorError','alertRepeatSensorError','helpSensorError',
    'alertTextPollError','alertTextStartupError','alertRepeatPollError','helpPollError',
    'alertOnLowWaterLevel','waterLevelSensorStateId','alertLowWaterLevelText','alertWaterLevelOkText','alertRepeatLowWaterLevel','helpLowWaterLevel','waterLevelTemplateHelp'
  ];
  for(const k of remove)delete old[k];

  const repeatField=(label,hidden)=>({
    type:'select',label,newLine:false,sm:12,md:4,lg:4,hidden,
    options:[
      {label:'Nur bei Ereignis / Zustandsänderung',value:'change'},
      {label:'Zusätzlich / erneut nach 1 Stunde',value:'1h'},
      {label:'Zusätzlich / erneut nach 24 Stunden',value:'24h'}
    ],
    help:'Bei Dauerzuständen kommt die erste Meldung sofort. 1h/24h erzeugt Erinnerungen nur in diesem Abstand, niemals jede Minute. Bei Ereignis-Alerts begrenzt die Auswahl, wie oft gleichartige Ereignisse erneut gemeldet werden.'
  });
  const textField=(label,hidden,help)=>({type:'text',label,newLine:true,sm:12,md:8,lg:8,hidden,help});
  const helpField=(text,hidden)=>({type:'staticText',text,newLine:true,sm:12,md:12,lg:12,hidden});

  const n={};
  for(const [k,v] of Object.entries(old)){
    n[k]=v;
    if(k==='enableAlerts'){
      n.alertVariableHelp={
        type:'staticText',newLine:true,sm:12,md:12,lg:12,
        text:'Alert-Texte können frei angepasst werden. Allgemeine Variablen für alle Texte: {date}, {time}, {datetime}, {key}, {severity}, {message}, {ph}, {orp}. Alert-spezifische Variablen stehen jeweils direkt unter dem betreffenden Alert. Unbenutzte Variablen können einfach weggelassen werden.'
      };
    }
    if(k==='alertOnPhDoseStarted'){
      const h='data.alertOnPhDoseStarted !== true';
      n.alertTextPhDoseStarted=textField('Text: pH-Dosierung gestartet',h,'Zusätzlich möglich: {ph}, {duration}, {ml}.');
      n.alertRepeatPhDoseStarted=repeatField('Wiederholung',h);
      n.helpPhDoseStarted=helpField('Variablen: {ph}=pH-Wert · {duration}=Laufzeit in Sekunden · {ml}=Dosiermenge in ml · plus alle allgemeinen Variablen.',h);
    }
    if(k==='alertOnPhDoseStopped'){
      const h='data.alertOnPhDoseStopped !== true';
      n.alertTextPhDoseStopped=textField('Text: pH-Dosierung beendet',h,'Zusätzlich möglich: {duration}, {ml}, {ph}.');
      n.alertRepeatPhDoseStopped=repeatField('Wiederholung',h);
      n.helpPhDoseStopped=helpField('Variablen: {duration}=Laufzeit in Sekunden · {ml}=Dosiermenge in ml · {ph}=aktueller pH · plus alle allgemeinen Variablen.',h);
    }
    if(k==='alertOnPhDoseAborted'){
      const h='data.alertOnPhDoseAborted !== true';
      n.alertTextPhDoseAborted=textField('Text: pH-Dosierung abgebrochen',h,'Zusätzlich möglich: {reason}, {ph}, {duration}, {ml}.');
      n.alertRepeatPhDoseAborted=repeatField('Wiederholung',h);
      n.helpPhDoseAborted=helpField('Variablen: {reason}=Abbruchgrund · {ph} · {duration} · {ml} · plus alle allgemeinen Variablen.',h);
    }
    if(k==='alertOnPhDailyLimit'){
      const h='data.alertOnPhDailyLimit !== true';
      n.alertTextPhDailyLimit=textField('Text: pH-Tageslimit erreicht',h,'Zusätzlich möglich: {dailyCount}, {dailyMax}, {ph}.');
      n.alertRepeatPhDailyLimit=repeatField('Wiederholung bei weiter erreichtem Limit',h);
      n.helpPhDailyLimit=helpField('Variablen: {dailyCount}=heutige Dosierungen · {dailyMax}=Tagesmaximum · {ph}=aktueller pH · plus alle allgemeinen Variablen.',h);
    }
    if(k==='alertOnSensorError'){
      const h='data.alertOnSensorError !== true';
      n.alertTextSensorError=textField('Text: Sensorfehler / ungültiger pH-Wert',h,'Zusätzlich möglich: {value}, {stateId}, {ph}.');
      n.alertRepeatSensorError=repeatField('Wiederholung solange Fehler besteht',h);
      n.helpSensorError=helpField('Variablen: {value}=gelieferter Sensorwert · {stateId}=betroffener pH-State · {ph}=aktueller pH bzw. - · plus alle allgemeinen Variablen.',h);
    }
    if(k==='alertOnPollError'){
      const h='data.alertOnPollError !== true';
      n.alertTextPollError=textField('Text: Poll-Fehler',h,'Zusätzlich möglich: {reason}.');
      n.alertTextStartupError=textField('Text: Startfehler',h,'Zusätzlich möglich: {reason}.');
      n.alertRepeatPollError=repeatField('Wiederholung gleicher Fehler',h);
      n.helpPollError=helpField('Variablen: {reason}=Fehlertext · plus alle allgemeinen Variablen.',h);

      // Wasserstand direkt nach den allgemeinen Fehler-Alerts einordnen.
      n.alertOnLowWaterLevel={type:'checkbox',label:'Bei zu niedrigem Pool-Wasserstand',newLine:true,sm:12,md:6,lg:6};
      n.waterLevelSensorStateId={type:'objectId',label:'State-ID Wasserstandssensor',objectTypes:['state'],newLine:true,sm:12,md:12,lg:12,hidden:'data.alertOnLowWaterLevel !== true',help:'0 = Wasserstand zu niedrig, jeder andere numerische Wert = Wasserstand OK.'};
      n.alertLowWaterLevelText=textField('Text: Wasserstand zu niedrig','data.alertOnLowWaterLevel !== true','Zusätzlich möglich: {value}, {stateId}, {status}.');
      n.alertRepeatLowWaterLevel=repeatField('Wiederholung solange Wasserstand niedrig','data.alertOnLowWaterLevel !== true');
      n.alertWaterLevelOkText={type:'text',label:'Text: Wasserstand wieder OK',newLine:true,sm:12,md:12,lg:12,hidden:'data.alertOnLowWaterLevel !== true',help:'Die Entwarnung wird einmalig beim Wechsel von niedrig auf OK gesendet. Variablen: {value}, {stateId}, {status} plus allgemeine Variablen.'};
      n.helpLowWaterLevel=helpField('Variablen: {value}=Sensorwert · {stateId}=Sensor-State · {status}=„zu niedrig“ oder „OK“ · plus alle allgemeinen Variablen. Bei „Nur Zustandsänderung“ gibt es genau eine Alarmmeldung und eine Entwarnung; bei 1h/24h zusätzlich Erinnerungen, solange der Sensor 0 bleibt.','data.alertOnLowWaterLevel !== true');
    }
  }
  cfg.items.alerts.items=n;
  fs.writeFileSync(adminFile,JSON.stringify(cfg,null,2)+'\n');
}
console.log('[0.5.57] Alert-Texte, Variablen und Wiederholmodi fuer alle Alerts eingerichtet');

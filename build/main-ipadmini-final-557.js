'use strict';

// 0.5.57: Einheitliche Alert-Engine fuer alle vorhandenen Alerts.
// - frei konfigurierbare Texte pro Alert
// - Variablen/Template-Platzhalter
// - Wiederholmodus pro Alert: Zustandsaenderung, 1h, 24h
// - Dauerzustaende (Wasserstand, pH-Sensor, Tageslimit) werden aktiv ueberwacht
// VIS/Layout bleiben unveraendert auf Basis 0.5.54.
const createBase = require('./main-ipadmini-final-554.js');

const VERSION = '0.5.57';
const DEFAULT_WATER_SENSOR = 'sonoff.0.TasmotaZB.ZbReceived_0xD61C_ZoneStatusChange';

const PROFILES = {
  ph_dose_started: {
    textKey: 'alertTextPhDoseStarted', repeatKey: 'alertRepeatPhDoseStarted',
    def: 'Poolsteuerung: pH-Dosierung gestartet · pH {ph} · Laufzeit {duration}s · ca. {ml} ml.'
  },
  ph_dose_stopped: {
    textKey: 'alertTextPhDoseStopped', repeatKey: 'alertRepeatPhDoseStopped',
    def: 'Poolsteuerung: pH-Dosierung beendet · Laufzeit {duration}s · ca. {ml} ml.'
  },
  ph_dose_aborted: {
    textKey: 'alertTextPhDoseAborted', repeatKey: 'alertRepeatPhDoseAborted',
    def: 'Poolsteuerung: pH-Dosierung abgebrochen · Grund: {reason}.'
  },
  ph_daily_limit: {
    textKey: 'alertTextPhDailyLimit', repeatKey: 'alertRepeatPhDailyLimit', persistent: true,
    def: 'Poolsteuerung: Tageslimit pH-Dosierung erreicht ({dailyCount}/{dailyMax}).'
  },
  ph_sensor_invalid: {
    textKey: 'alertTextSensorError', repeatKey: 'alertRepeatSensorError', persistent: true,
    def: 'Poolsteuerung: pH-Sensorwert ist ungültig oder fehlt. Bitte Sensor prüfen.'
  },
  poll_error: {
    textKey: 'alertTextPollError', repeatKey: 'alertRepeatPollError',
    def: 'Poolsteuerung: Poll-Fehler · {reason}'
  },
  startup_error: {
    textKey: 'alertTextStartupError', repeatKey: 'alertRepeatPollError',
    def: 'Poolsteuerung: Startfehler · {reason}'
  },
  water_level_low: {
    textKey: 'alertLowWaterLevelText', repeatKey: 'alertRepeatLowWaterLevel', persistent: true,
    def: 'Poolsteuerung: Wasserstand zu niedrig! Bitte Pool-Wasserstand prüfen.'
  },
  water_level_ok: {
    textKey: 'alertWaterLevelOkText', repeatKey: 'alertRepeatLowWaterLevel', recovery: true,
    def: 'Poolsteuerung: Wasserstand wieder OK.'
  }
};

const EVENT_KEYS = new Set(['ph_dose_started','ph_dose_stopped','ph_dose_aborted','poll_error','startup_error']);

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function pad(v){ return String(v).padStart(2,'0'); }
function bool(v){ if(typeof v==='boolean')return v;if(typeof v==='number')return v!==0;return ['1','true','on','ein','yes','ja','aktiv','active'].includes(String(v??'').trim().toLowerCase()); }
function modeMs(mode){ return mode==='1h' ? 60*60*1000 : mode==='24h' ? 24*60*60*1000 : 0; }
function normalizeMode(v){ return ['1h','24h'].includes(String(v||'')) ? String(v) : 'change'; }
function fmtNum(v,d=0){ const n=num(v); return n===null ? '-' : n.toFixed(d).replace('.',','); }

function baseVars(key,severity,originalMessage){
  const d=new Date();
  const date=`${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`;
  const time=`${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { key, severity:String(severity||''), date, time, datetime:`${date} ${time}`, message:String(originalMessage||'') };
}

function renderTemplate(template, vars){
  return String(template||'').replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,(m,k)=>Object.prototype.hasOwnProperty.call(vars,k)?String(vars[k]??''):m);
}

function parseOriginal(key,message){
  const s=String(message||'');
  const out={};
  if(key==='ph_dose_started'){
    const p=s.match(/pH\s+([\d.,-]+)/i); if(p)out.ph=p[1];
    const d=s.match(/Laufzeit\s+(\d+)s/i); if(d)out.duration=d[1];
  }
  if(key==='ph_dose_aborted'){
    const r=s.match(/Grund:\s*(.+?)(?:\.|$)/i); if(r)out.reason=r[1];
  }
  if(key==='ph_daily_limit'){
    const m=s.match(/\((\d+)\s*\/\s*(\d+)\)/); if(m){out.dailyCount=m[1];out.dailyMax=m[2];}
  }
  if(key==='poll_error'||key==='startup_error'){
    const parts=s.split(/\s+-\s+|\s+·\s+/); out.reason=parts.length>1?parts.slice(1).join(' · '):s.replace(/^Poolsteuerung:\s*(?:Poll-Fehler|Startfehler)\s*/i,'');
  }
  return out;
}

function install(adapter){
  if(!adapter||adapter.__alertEngine557Installed)return adapter;
  adapter.__alertEngine557Installed=true;

  const runtime=new Map(); // key -> {active,lastSent,lastFingerprint}
  let waterLastLow=null;
  let waterSubscribed='';
  let monitorTimer=null;

  function profileFor(key){ return PROFILES[key]||null; }
  function repeatMode(key){ const p=profileFor(key); return p ? normalizeMode(adapter.config&&adapter.config[p.repeatKey]) : 'change'; }
  function configuredTemplate(key){ const p=profileFor(key); if(!p)return ''; const v=adapter.config&&adapter.config[p.textKey]; return String(v||p.def); }
  function rt(key){ if(!runtime.has(key))runtime.set(key,{active:false,lastSent:0,lastFingerprint:''}); return runtime.get(key); }

  async function readState(id){ try{return await adapter.getStateAsync(id);}catch{return null;} }
  async function readForeign(id){ try{return id?await adapter.getForeignStateAsync(id):null;}catch{return null;} }

  async function liveVars(key,severity,originalMessage,extra={}){
    const vars={...baseVars(key,severity,originalMessage),...parseOriginal(key,originalMessage),...extra};
    const cfg=adapter.config||{};
    if(vars.ph===undefined){ const s=await readForeign(cfg.phStateId); const n=num(s&&s.val); vars.ph=n===null?'-':fmtNum(n,2); }
    if(vars.orp===undefined){ const s=await readForeign(cfg.orpStateId); const n=num(s&&s.val); vars.orp=n===null?'-':fmtNum(n,0); }
    if(vars.dailyCount===undefined){ const s=await readState('status.phDose.dailyCount'); vars.dailyCount=String(Number(s&&s.val)||0); }
    if(vars.dailyMax===undefined) vars.dailyMax=String(Math.max(1,Number(cfg.phDoseMaxPerDay)||4));
    if(vars.duration===undefined){ const s=await readState('status.phDose.lastDoseDurationSec'); vars.duration=String(Number(s&&s.val)||0); }
    if(vars.ml===undefined){
      const direct=await readState('status.phDose.lastDoseMl');
      let ml=Number(direct&&direct.val)||0;
      if(!ml && Number(vars.duration)>0){ const flow=num(cfg.phPumpFlowMlPerMin)||0; ml=Math.round(Number(vars.duration)*flow/60); }
      vars.ml=String(Math.round(ml));
    }
    if(vars.reason===undefined)vars.reason='-';
    if(vars.value===undefined)vars.value='-';
    if(vars.stateId===undefined)vars.stateId='-';
    if(vars.status===undefined)vars.status=severity==='error'||severity==='warn'?'ALARM':'OK';
    return vars;
  }

  function shouldDispatch(key,fingerprint,forceRecovery=false){
    const p=profileFor(key);
    const state=rt(key);
    const now=Date.now();
    if(forceRecovery||p&&p.recovery){ state.lastSent=now; state.lastFingerprint=fingerprint; return true; }
    const mode=repeatMode(key);
    const interval=modeMs(mode);

    if(EVENT_KEYS.has(key)){
      if(mode==='change') { state.lastSent=now; state.lastFingerprint=fingerprint; return true; }
      if(!state.lastSent||now-state.lastSent>=interval){state.lastSent=now;state.lastFingerprint=fingerprint;return true;}
      return false;
    }

    // Dauerzustand: change = exakt einmal pro aktiver Alarmphase.
    if(!state.active){ state.active=true; state.lastSent=now; state.lastFingerprint=fingerprint; return true; }
    if(mode==='change')return false;
    if(!state.lastSent||now-state.lastSent>=interval){state.lastSent=now;state.lastFingerprint=fingerprint;return true;}
    return false;
  }

  function clearPersistent(key){ const state=rt(key); state.active=false; state.lastSent=0; state.lastFingerprint=''; }

  async function dispatchChannels(key,severity,text){
    if(!adapter.config||adapter.config.adapterEnabled===false||adapter.config.enableAlerts!==true)return false;
    let sent=false;
    const isPhDose=String(key).startsWith('ph_dose');
    const phWaEnabled=!isPhDose||await adapter.getControlBool('control.notifications.phDoseWhatsapp',true);
    if(phWaEnabled&&typeof adapter.dispatchWhatsappAlert==='function') sent=(await adapter.dispatchWhatsappAlert(text))||sent;
    if(typeof adapter.dispatchTelegramAlert==='function') sent=(await adapter.dispatchTelegramAlert(text))||sent;
    if(typeof adapter.dispatchEmailAlert==='function') sent=(await adapter.dispatchEmailAlert(text))||sent;
    try{
      await adapter.ensureAlertStates();
      await adapter.setStateIfChanged('status.alerts.lastMessage',text,true);
      await adapter.setStateIfChanged('status.alerts.lastSeverity',severity,true);
      await adapter.setStateIfChanged('status.alerts.lastKey',key,true);
      await adapter.setStateIfChanged('status.alerts.lastSentTs',Date.now(),true);
    }catch{}
    if(adapter.log){ if(sent)adapter.log.info(`[ALERT] ${text}`); else if(adapter.config.debugMode)adapter.log.debug(`[ALERT] Kein aktiver Versandkanal: ${text}`); }
    return sent;
  }

  async function emit(key,severity,originalMessage,extra={},forceRecovery=false){
    const p=profileFor(key);
    if(!p){
      // unbekannter Alert bleibt kompatibel und nutzt Originaltext, aber ohne alte globale Wiederholsperre
      return dispatchChannels(key,severity,String(originalMessage||''));
    }
    const vars=await liveVars(key,severity,originalMessage,extra);
    const text=renderTemplate(configuredTemplate(key),vars);
    const fingerprint=JSON.stringify({key,status:vars.status,value:vars.value,reason:vars.reason,dailyCount:vars.dailyCount,dailyMax:vars.dailyMax});
    if(!shouldDispatch(key,fingerprint,forceRecovery))return false;
    return dispatchChannels(key,severity,text);
  }

  // Zentrale Alert-Methode des Basisadapters ersetzen.
  adapter.sendAlert=async function sendAlert557(key,severity,message){ return emit(String(key||''),String(severity||'info'),message||''); };

  function waterSensor(){ return String((adapter.config&&adapter.config.waterLevelSensorStateId)||DEFAULT_WATER_SENSOR).trim(); }
  function waterEnabled(){ return !!(adapter.config&&adapter.config.enableAlerts===true&&adapter.config.alertOnLowWaterLevel===true); }
  async function ensureWaterStates(){
    await adapter.setObjectNotExistsAsync('status.waterLevel.low',{type:'state',common:{name:'Pool Wasserstand zu niedrig',type:'boolean',role:'indicator.alarm',read:true,write:false,def:false},native:{}});
    await adapter.setObjectNotExistsAsync('status.waterLevel.sensorValue',{type:'state',common:{name:'Pool Wasserstand Sensorwert',type:'number',role:'value',read:true,write:false,def:0},native:{}});
    await adapter.setObjectNotExistsAsync('status.waterLevel.lastAlert',{type:'state',common:{name:'Letzte Wasserstandsmeldung',type:'string',role:'text',read:true,write:false,def:''},native:{}});
  }
  async function evalWater(value,reason){
    const n=num(value); if(n===null)return;
    const low=n===0;
    await adapter.setStateIfChanged('status.waterLevel.sensorValue',n,true).catch(()=>{});
    await adapter.setStateIfChanged('status.waterLevel.low',low,true).catch(()=>{});
    if(!waterEnabled()){ waterLastLow=low; return; }
    const extra={value:String(n),stateId:waterSensor(),status:low?'zu niedrig':'OK'};
    if(waterLastLow===null){
      waterLastLow=low;
      if(low)await emit('water_level_low','warn','',extra);
      return;
    }
    if(low!==waterLastLow){
      waterLastLow=low;
      if(low) await emit('water_level_low','warn','',extra);
      else { clearPersistent('water_level_low'); await emit('water_level_ok','info','',extra,true); }
      return;
    }
    if(low){
      // Bei 1h/24h sorgt shouldDispatch fuer den korrekten Erinnerungsabstand.
      await emit('water_level_low','warn','',extra);
    }
    if(adapter.config&&adapter.config.debugMode)adapter.log.debug(`[ALERT557] Wasser ${reason}: ${low?'niedrig':'OK'} (${n})`);
  }
  async function pollWater(reason='Poll'){
    const id=waterSensor(); if(!id)return;
    const s=await readForeign(id); if(s)await evalWater(s.val,reason);
  }
  function subscribeWater(){
    const id=waterSensor(); if(!id||id===waterSubscribed)return;
    try{if(waterSubscribed&&typeof adapter.unsubscribeForeignStates==='function')adapter.unsubscribeForeignStates(waterSubscribed);}catch{}
    waterSubscribed=id; try{adapter.subscribeForeignStates(id);}catch{}
  }

  async function monitorPersistent(){
    const cfg=adapter.config||{};
    // pH-Sensorfehler: Alarmphase aktiv solange kein gueltiger numerischer pH-Wert vorliegt.
    if(cfg.alertOnSensorError&&cfg.enableAlerts){
      const s=await readForeign(cfg.phStateId); const p=num(s&&s.val);
      if(p===null){ await emit('ph_sensor_invalid','warn','Poolsteuerung: pH-Sensorwert ist ungültig oder fehlt.',{value:String(s&&s.val??''),stateId:String(cfg.phStateId||''),status:'ungültig'}); }
      else clearPersistent('ph_sensor_invalid');
    } else clearPersistent('ph_sensor_invalid');

    // Tageslimit: automatische Erinnerung nur solange das Limit wirklich erreicht ist.
    if(cfg.alertOnPhDailyLimit&&cfg.enableAlerts){
      const s=await readState('status.phDose.dailyCount'); const count=Number(s&&s.val)||0; const max=Math.max(1,Number(cfg.phDoseMaxPerDay)||4);
      if(count>=max){ await emit('ph_daily_limit','warn',`Poolsteuerung: Tageslimit pH-Dosierung erreicht (${count}/${max}).`,{dailyCount:String(count),dailyMax:String(max),status:'Limit erreicht'}); }
      else clearPersistent('ph_daily_limit');
    } else clearPersistent('ph_daily_limit');

    await pollWater('Monitor');
  }

  adapter.on('stateChange',(id,state)=>{
    if(!state||adapter.isShuttingDown)return;
    if(String(id)===waterSensor())evalWater(state.val,'StateChange').catch(()=>{});
  });

  adapter.on('ready',()=>{
    ensureWaterStates().then(async()=>{subscribeWater();await pollWater('Start');}).catch(()=>{});
    const h=setInterval(()=>{if(!adapter.isShuttingDown)monitorPersistent().catch(e=>{if(adapter.config&&adapter.config.debugMode)adapter.log.debug(`[ALERT557] Monitor: ${e.message||e}`);});},60*1000);
    monitorTimer=h; if(typeof adapter.trackInterval==='function')adapter.trackInterval(h);
  });
  ensureWaterStates().catch(()=>{});
  return adapter;
}

function createAdapter(options={}){ return install(createBase(options)); }
if(require.main!==module)module.exports=createAdapter;else createAdapter();

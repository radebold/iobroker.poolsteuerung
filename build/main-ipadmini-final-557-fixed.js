'use strict';

// 0.5.57: Einheitliche Alert-Engine fuer alle vorhandenen Alerts.
// Frei konfigurierbare Texte + Variablen + Wiederholmodus pro Alert.
// Dauerzustaende Wasserstand, pH-Sensor und Tageslimit werden aktiv ueberwacht.
// VIS/Layout bleiben unveraendert auf Basis 0.5.54.
const createBase = require('./main-ipadmini-final-554.js');

const DEFAULT_WATER_SENSOR = 'sonoff.0.TasmotaZB.ZbReceived_0xD61C_ZoneStatusChange';
const PROFILES = {
  ph_dose_started: { textKey:'alertTextPhDoseStarted', repeatKey:'alertRepeatPhDoseStarted', def:'Poolsteuerung: pH-Dosierung gestartet · pH {ph} · Laufzeit {duration}s · ca. {ml} ml.' },
  ph_dose_stopped: { textKey:'alertTextPhDoseStopped', repeatKey:'alertRepeatPhDoseStopped', def:'Poolsteuerung: pH-Dosierung beendet · Laufzeit {duration}s · ca. {ml} ml.' },
  ph_dose_aborted: { textKey:'alertTextPhDoseAborted', repeatKey:'alertRepeatPhDoseAborted', def:'Poolsteuerung: pH-Dosierung abgebrochen · Grund: {reason}.' },
  ph_daily_limit: { textKey:'alertTextPhDailyLimit', repeatKey:'alertRepeatPhDailyLimit', persistent:true, def:'Poolsteuerung: Tageslimit pH-Dosierung erreicht ({dailyCount}/{dailyMax}).' },
  ph_sensor_invalid: { textKey:'alertTextSensorError', repeatKey:'alertRepeatSensorError', persistent:true, def:'Poolsteuerung: pH-Sensorwert ist ungültig oder fehlt. Bitte Sensor prüfen.' },
  poll_error: { textKey:'alertTextPollError', repeatKey:'alertRepeatPollError', def:'Poolsteuerung: Poll-Fehler · {reason}' },
  startup_error: { textKey:'alertTextStartupError', repeatKey:'alertRepeatPollError', def:'Poolsteuerung: Startfehler · {reason}' },
  water_level_low: { textKey:'alertLowWaterLevelText', repeatKey:'alertRepeatLowWaterLevel', persistent:true, def:'Poolsteuerung: Wasserstand zu niedrig! Bitte Pool-Wasserstand prüfen.' },
  water_level_ok: { textKey:'alertWaterLevelOkText', repeatKey:'alertRepeatLowWaterLevel', recovery:true, def:'Poolsteuerung: Wasserstand wieder OK.' }
};
const EVENT_KEYS = new Set(['ph_dose_started','ph_dose_stopped','ph_dose_aborted','poll_error','startup_error']);

function num(v){ if(v===undefined||v===null||v==='')return null; const n=Number(String(v).trim().replace(',','.')); return Number.isFinite(n)?n:null; }
function pad(v){ return String(v).padStart(2,'0'); }
function mode(v){ return ['1h','24h'].includes(String(v||''))?String(v):'change'; }
function modeMs(v){ return v==='1h'?3600000:v==='24h'?86400000:0; }
function fmt(v,d=0){ const n=num(v); return n===null?'-':n.toFixed(d).replace('.',','); }
function baseVars(key,severity,original){ const d=new Date(); const date=`${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`; const time=`${pad(d.getHours())}:${pad(d.getMinutes())}`; return {key,severity:String(severity||''),date,time,datetime:`${date} ${time}`,message:String(original||'')}; }
function render(template,vars){ return String(template||'').replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(m,k)=>Object.prototype.hasOwnProperty.call(vars,k)?String(vars[k]??''):m); }
function parseOriginal(key,message){
  const s=String(message||''), out={};
  if(key==='ph_dose_started'){
    const p=s.match(/pH\s+([\d.,-]+)/i); if(p)out.ph=p[1];
    const d=s.match(/Laufzeit\s+(\d+)s/i); if(d)out.duration=d[1];
  }
  if(key==='ph_dose_aborted'){ const r=s.match(/Grund:\s*(.+?)(?:\.|$)/i); if(r)out.reason=r[1]; }
  if(key==='ph_daily_limit'){ const m=s.match(/\((\d+)\s*\/\s*(\d+)\)/); if(m){out.dailyCount=m[1];out.dailyMax=m[2];} }
  if(key==='poll_error'||key==='startup_error'){
    const parts=s.split(/\s+-\s+|\s+·\s+/); out.reason=parts.length>1?parts.slice(1).join(' · '):s.replace(/^Poolsteuerung:\s*(?:Poll-Fehler|Startfehler)\s*/i,'');
  }
  return out;
}

function install(adapter){
  if(!adapter||adapter.__alertEngine557Installed)return adapter;
  adapter.__alertEngine557Installed=true;
  const runtime=new Map();
  let waterLastLow=null;
  let waterSubscribed='';

  function profile(key){ return PROFILES[key]||null; }
  function repeatMode(key){ const p=profile(key); return p?mode(adapter.config&&adapter.config[p.repeatKey]):'change'; }
  function template(key){ const p=profile(key); if(!p)return ''; return String((adapter.config&&adapter.config[p.textKey])||p.def); }
  function stateFor(key){ if(!runtime.has(key))runtime.set(key,{active:false,lastSent:0}); return runtime.get(key); }
  function clearPersistent(key){ const s=stateFor(key); s.active=false; s.lastSent=0; }
  async function localState(id){ try{return await adapter.getStateAsync(id);}catch{return null;} }
  async function foreignState(id){ try{return id?await adapter.getForeignStateAsync(id):null;}catch{return null;} }

  async function varsFor(key,severity,original,extra={}){
    const vars={...baseVars(key,severity,original),...parseOriginal(key,original),...extra};
    const cfg=adapter.config||{};
    if(vars.ph===undefined){ const s=await foreignState(cfg.phStateId); vars.ph=num(s&&s.val)===null?'-':fmt(s.val,2); }
    if(vars.orp===undefined){ const s=await foreignState(cfg.orpStateId); vars.orp=num(s&&s.val)===null?'-':fmt(s.val,0); }
    if(vars.dailyCount===undefined){ const s=await localState('status.phDose.dailyCount'); vars.dailyCount=String(Number(s&&s.val)||0); }
    if(vars.dailyMax===undefined)vars.dailyMax=String(Math.max(1,Number(cfg.phDoseMaxPerDay)||4));
    if(vars.duration===undefined){ const s=await localState('status.phDose.lastDoseDurationSec'); vars.duration=String(Number(s&&s.val)||0); }
    if(vars.ml===undefined){
      const s=await localState('status.phDose.lastDoseMl'); let ml=Number(s&&s.val)||0;
      if(!ml&&Number(vars.duration)>0){ const flow=num(cfg.phPumpFlowMlPerMin)||0; ml=Math.round(Number(vars.duration)*flow/60); }
      vars.ml=String(Math.round(ml));
    }
    if(vars.reason===undefined)vars.reason='-';
    if(vars.value===undefined)vars.value='-';
    if(vars.stateId===undefined)vars.stateId='-';
    if(vars.status===undefined)vars.status=(severity==='warn'||severity==='error')?'ALARM':'OK';
    return vars;
  }

  function shouldSend(key,forceRecovery=false){
    const p=profile(key), s=stateFor(key), now=Date.now();
    if(forceRecovery||(p&&p.recovery)){s.lastSent=now;return true;}
    const m=repeatMode(key), interval=modeMs(m);
    if(EVENT_KEYS.has(key)){
      if(m==='change'){s.lastSent=now;return true;}
      if(!s.lastSent||now-s.lastSent>=interval){s.lastSent=now;return true;}
      return false;
    }
    if(!s.active){s.active=true;s.lastSent=now;return true;}
    if(m==='change')return false;
    if(!s.lastSent||now-s.lastSent>=interval){s.lastSent=now;return true;}
    return false;
  }

  async function dispatch(key,severity,text){
    const cfg=adapter.config||{};
    if(cfg.adapterEnabled===false||cfg.enableAlerts!==true)return false;
    let sent=false;
    const isDose=String(key).startsWith('ph_dose');
    const waDoseOk=!isDose||await adapter.getControlBool('control.notifications.phDoseWhatsapp',true);
    if(waDoseOk&&typeof adapter.dispatchWhatsappAlert==='function')sent=(await adapter.dispatchWhatsappAlert(text))||sent;
    if(typeof adapter.dispatchTelegramAlert==='function')sent=(await adapter.dispatchTelegramAlert(text))||sent;
    if(typeof adapter.dispatchEmailAlert==='function')sent=(await adapter.dispatchEmailAlert(text))||sent;
    try{
      await adapter.ensureAlertStates();
      await adapter.setStateIfChanged('status.alerts.lastMessage',text,true);
      await adapter.setStateIfChanged('status.alerts.lastSeverity',severity,true);
      await adapter.setStateIfChanged('status.alerts.lastKey',key,true);
      await adapter.setStateIfChanged('status.alerts.lastSentTs',Date.now(),true);
    }catch{}
    if(adapter.log){ if(sent)adapter.log.info(`[ALERT] ${text}`); else if(cfg.debugMode)adapter.log.debug(`[ALERT] Kein aktiver Versandkanal: ${text}`); }
    return sent;
  }

  async function emit(key,severity,original='',extra={},forceRecovery=false){
    const p=profile(key);
    if(!p)return dispatch(key,severity,String(original||''));
    if(!shouldSend(key,forceRecovery))return false;
    const vars=await varsFor(key,severity,original,extra);
    return dispatch(key,severity,render(template(key),vars));
  }

  adapter.sendAlert=async function sendAlert557(key,severity,message){ return emit(String(key||''),String(severity||'info'),message||''); };

  function waterSensor(){ return String((adapter.config&&adapter.config.waterLevelSensorStateId)||DEFAULT_WATER_SENSOR).trim(); }
  function waterEnabled(){ const c=adapter.config||{}; return c.enableAlerts===true&&c.alertOnLowWaterLevel===true; }
  async function ensureWaterStates(){
    await adapter.setObjectNotExistsAsync('status.waterLevel.low',{type:'state',common:{name:'Pool Wasserstand zu niedrig',type:'boolean',role:'indicator.alarm',read:true,write:false,def:false},native:{}});
    await adapter.setObjectNotExistsAsync('status.waterLevel.sensorValue',{type:'state',common:{name:'Pool Wasserstand Sensorwert',type:'number',role:'value',read:true,write:false,def:0},native:{}});
    await adapter.setObjectNotExistsAsync('status.waterLevel.lastAlert',{type:'state',common:{name:'Letzte Wasserstandsmeldung',type:'string',role:'text',read:true,write:false,def:''},native:{}});
  }
  async function evalWater(value){
    const n=num(value); if(n===null)return;
    const low=n===0;
    await adapter.setStateIfChanged('status.waterLevel.sensorValue',n,true).catch(()=>{});
    await adapter.setStateIfChanged('status.waterLevel.low',low,true).catch(()=>{});
    if(!waterEnabled()){waterLastLow=low;clearPersistent('water_level_low');return;}
    const extra={value:String(n),stateId:waterSensor(),status:low?'zu niedrig':'OK'};
    if(waterLastLow===null){waterLastLow=low;if(low)await emit('water_level_low','warn','',extra);return;}
    if(low!==waterLastLow){
      waterLastLow=low;
      if(low)await emit('water_level_low','warn','',extra);
      else{clearPersistent('water_level_low');await emit('water_level_ok','info','',extra,true);}
      return;
    }
    if(low)await emit('water_level_low','warn','',extra);
  }
  async function pollWater(){ const s=await foreignState(waterSensor()); if(s)await evalWater(s.val); }
  function subscribeWater(){ const id=waterSensor(); if(!id||id===waterSubscribed)return; try{if(waterSubscribed&&typeof adapter.unsubscribeForeignStates==='function')adapter.unsubscribeForeignStates(waterSubscribed);}catch{} waterSubscribed=id; try{adapter.subscribeForeignStates(id);}catch{} }

  async function monitorPersistent(){
    const cfg=adapter.config||{};
    if(cfg.alertOnSensorError&&cfg.enableAlerts){
      const s=await foreignState(cfg.phStateId), p=num(s&&s.val);
      if(p===null){ const raw=(s&&s.val!==undefined&&s.val!==null)?s.val:''; await emit('ph_sensor_invalid','warn','Poolsteuerung: pH-Sensorwert ist ungültig oder fehlt.',{value:String(raw),stateId:String(cfg.phStateId||''),status:'ungültig'}); }
      else clearPersistent('ph_sensor_invalid');
    }else clearPersistent('ph_sensor_invalid');

    if(cfg.alertOnPhDailyLimit&&cfg.enableAlerts){
      const s=await localState('status.phDose.dailyCount'), count=Number(s&&s.val)||0, max=Math.max(1,Number(cfg.phDoseMaxPerDay)||4);
      if(count>=max)await emit('ph_daily_limit','warn',`Poolsteuerung: Tageslimit pH-Dosierung erreicht (${count}/${max}).`,{dailyCount:String(count),dailyMax:String(max),status:'Limit erreicht'});
      else clearPersistent('ph_daily_limit');
    }else clearPersistent('ph_daily_limit');

    await pollWater();
  }

  adapter.on('stateChange',(id,state)=>{ if(state&&!adapter.isShuttingDown&&String(id)===waterSensor())evalWater(state.val).catch(()=>{}); });
  adapter.on('ready',()=>{
    ensureWaterStates().then(async()=>{subscribeWater();await pollWater();}).catch(()=>{});
    const h=setInterval(()=>{if(!adapter.isShuttingDown)monitorPersistent().catch(()=>{});},60000);
    if(typeof adapter.trackInterval==='function')adapter.trackInterval(h);
  });
  ensureWaterStates().catch(()=>{});
  return adapter;
}

function createAdapter(options={}){return install(createBase(options));}
if(require.main!==module)module.exports=createAdapter;else createAdapter();

'use strict';

// 0.5.50: Wiederherstellungsstand.
// VIS basiert direkt auf 0.5.46 und wird NICHT nachtraeglich per HTML-Injektion veraendert.
// Backend-Fixes: Tasmota ZbReceived read-only guard, pH-Kalibrierobjekte, Nacht-Reset Scheduler.
const createBase = require('./main-ipadmini-final-546.js');

const VERSION = 'v0.5.50';
const FLAG_ID = 'control.nightlyAutoResetEnabled';
const LAST_ID = 'status.nightlyAutoReset.lastRun';
const DEBUG_ID = 'status.debug.nightlyAutoReset550';

const REQUIRED = {
  'status.phCalibration.lastPollTs': {type:'state',common:{name:'Zeitstempel letzte pH-Kalibrierungsabfrage',type:'number',role:'value.time',read:true,write:false,def:0},native:{}},
  'status.phCalibration.poolRaw': {type:'state',common:{name:'Pool pH Rohwert für Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}},
  'status.phCalibration.poolCorrected': {type:'state',common:{name:'Pool pH korrigierter Wert für Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}}
};

function boolValue(v){
  if(v&&typeof v==='object'&&Object.prototype.hasOwnProperty.call(v,'val')) v=v.val;
  if(typeof v==='boolean') return v;
  if(typeof v==='number') return v!==0;
  return ['true','1','on','ein','yes','ja','active','aktiv'].includes(String(v??'').trim().toLowerCase());
}
function validTime(value){
  const m=String(value||'').trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const h=Number(m[1]),min=Number(m[2]);
  if(h<0||h>23||min<0||min>59) return null;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}
function dateKey(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function timeKey(d=new Date()){return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
function tasmotaTarget(id){
  const m=String(id||'').match(/^(.*)\.ZbReceived_(0x[0-9A-Fa-f]+)_Power$/);
  return m?{cmd:`${m[1]}.ZbSend`,device:m[2]}:null;
}

function install(adapter){
  if(!adapter||adapter.__restore550Installed) return adapter;
  adapter.__restore550Installed=true;
  let lastRunDay='';
  let running=false;

  async function ensureRequired(){
    for(const [id,obj] of Object.entries(REQUIRED)) await adapter.setObjectNotExistsAsync(id,obj);
    await adapter.setObjectNotExistsAsync(FLAG_ID,{type:'state',common:{name:'Nächtlicher Automatik-Reset',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
    await adapter.setObjectNotExistsAsync(LAST_ID,{type:'state',common:{name:'Letzter nächtlicher Automatik-Reset',type:'string',role:'text',read:true,write:false,def:''},native:{}});
    await adapter.setObjectNotExistsAsync(DEBUG_ID,{type:'state',common:{name:'Nacht-Reset Diagnose 0.5.50',type:'string',role:'text',read:true,write:false,def:''},native:{}});
  }

  // pH-Objekte vor jedem moeglichen Schreibzugriff absichern.
  const rawSetStateIfChanged=typeof adapter.setStateIfChanged==='function'?adapter.setStateIfChanged.bind(adapter):null;
  if(rawSetStateIfChanged){
    adapter.setStateIfChanged=async function(id,value,ack,...rest){
      if(REQUIRED[id]) await adapter.setObjectNotExistsAsync(id,REQUIRED[id]);
      return rawSetStateIfChanged(id,value,ack,...rest);
    };
  }
  const rawSetStateAsync=typeof adapter.setStateAsync==='function'?adapter.setStateAsync.bind(adapter):null;
  if(rawSetStateAsync){
    adapter.setStateAsync=async function(id,...args){
      if(REQUIRED[id]) await adapter.setObjectNotExistsAsync(id,REQUIRED[id]);
      return rawSetStateAsync(id,...args);
    };
  }

  // Nie direkt in Tasmota ZbReceived_*_Power schreiben.
  const rawForeign=typeof adapter.setForeignStateAsync==='function'?adapter.setForeignStateAsync.bind(adapter):null;
  if(rawForeign){
    adapter.setForeignStateAsync=async function(id,value,...args){
      const t=tasmotaTarget(id);
      if(!t) return rawForeign(id,value,...args);
      const payload=JSON.stringify({Device:t.device,Send:{Power:boolValue(value)?1:0}});
      if(adapter.config&&adapter.config.debugMode&&adapter.log) adapter.log.debug(`[ZB-GUARD 0.5.50] ${id} -> ${t.cmd}`);
      return rawForeign(t.cmd,payload,false);
    };
  }

  // Konfigurationsbedingte Meldungen nicht als Warnflut behandeln.
  if(adapter.log&&typeof adapter.log.warn==='function'){
    const oldWarn=adapter.log.warn.bind(adapter.log);
    const info=typeof adapter.log.info==='function'?adapter.log.info.bind(adapter.log):oldWarn;
    adapter.log.warn=function(msg,...args){
      const s=String(msg||'');
      if(s.includes('[ALERT] Kein aktiver Versandkanal')){
        if(adapter.config&&adapter.config.debugMode) info(s,...args);
        return;
      }
      if(s.includes('[CHLOR-OWNER')&&s.includes('unerwartet AUS')&&s.includes('wiederhergestellt')) return info(s,...args);
      return oldWarn(s,...args);
    };
  }

  async function switchOff(id,mode,label){
    id=String(id||'').trim();
    if(!id) return `${label}: nicht konfiguriert`;
    const t=tasmotaTarget(id);
    if(t){await rawForeign(t.cmd,JSON.stringify({Device:t.device,Send:{Power:0}}),false);return `${label}: AUS via ZbSend`;}
    let obj=null;try{obj=await adapter.getForeignObjectAsync(id);}catch{}
    if(obj&&obj.common&&obj.common.write===false) return `${label}: nicht geschaltet (read-only)`;
    const value=String(mode||'').toLowerCase()==='num01'||(obj&&obj.common&&obj.common.type==='number')?0:false;
    await rawForeign(id,value,false);return `${label}: AUS`;
  }
  async function enableAuto(local){
    try{const s=await adapter.getStateAsync(local);if(!s||!boolValue(s.val)) await adapter.setStateAsync(local,true,false);return `${local}: EIN`;}catch(e){return `${local}: ${e.message||e}`;}
  }
  async function runReset(reason){
    if(running||adapter.isShuttingDown) return;
    running=true;
    try{
      if(adapter.config&&adapter.config.standbyModeEnabled===true){
        await adapter.setStateIfChanged(DEBUG_ID,`ÜBERSPRUNGEN · ${reason} · Standby aktiv`,true);return;
      }
      const cfg=adapter.config||{};
      const off=[];
      for(const [id,mode,label] of [[cfg.chlorinatorSocketStateId,cfg.chlorinatorWriteMode,'Chlorinator'],[cfg.phPumpSocketStateId,cfg.phPumpWriteMode,'pH-Dosierpumpe'],[cfg.heatpumpPowerStateId,'','Wärmepumpe'],[cfg.circulationPumpSocketStateId,cfg.circulationPumpWriteMode,'Umwälzpumpe']]){
        try{off.push(await switchOff(id,mode,label));}catch(e){off.push(`${label}: ${e.message||e}`);}
      }
      await new Promise(r=>setTimeout(r,900));
      const autos=[];
      for(const id of ['control.auto.pump','control.auto.chlor','control.auto.ph','control.auto.heatpump']) autos.push(await enableAuto(id));
      const stamp=new Date().toLocaleString('de-DE');
      await adapter.setStateIfChanged(LAST_ID,stamp,true);
      await adapter.setStateIfChanged(DEBUG_ID,`AUSGEFÜHRT · ${reason} · ${off.join(' | ')} · ${autos.join(' | ')}`,true);
      if(adapter.log) adapter.log.info(`[NACHT-RESET 0.5.50] ausgeführt`);
    } finally {running=false;}
  }
  async function checkReset(){
    const flag=await adapter.getStateAsync(FLAG_ID);if(!flag||!boolValue(flag.val)) return;
    const t=validTime(adapter.config&&adapter.config.nightlyAutoResetTime)||'22:00';
    const now=new Date();if(timeKey(now)!==t) return;
    const day=dateKey(now);if(lastRunDay===day) return;lastRunDay=day;await runReset(t);
  }

  adapter.on('ready',()=>{
    ensureRequired().catch(e=>adapter.log&&adapter.log.error(`[0.5.50] Objektanlage: ${e.message||e}`));
    const timer=setInterval(()=>{if(!adapter.isShuttingDown) checkReset().catch(e=>adapter.log&&adapter.log.error(`[0.5.50] Nacht-Reset: ${e.message||e}`));},15000);
    if(typeof adapter.trackInterval==='function') adapter.trackInterval(timer);
  });
  ensureRequired().catch(()=>{});
  return adapter;
}

function createAdapter(options={}){return install(createBase(options));}
if(require.main!==module) module.exports=createAdapter; else createAdapter();

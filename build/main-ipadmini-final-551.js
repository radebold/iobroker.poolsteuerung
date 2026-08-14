'use strict';

// 0.5.51: VIS-Wiederherstellung auf Basis des letzten nachweislich vollstaendigen
// Renderstands 0.5.43. Keine nachtraegliche HTML-Injektion.
// Gleichzeitig werden pH-Pruefzeiten und Sperrzeit gegen alte innere Wrapper
// (0.5.40/0.5.43) geschuetzt.
const createBase = require('./main-ipadmini-final-543.js');
const VERSION = 'v0.5.51';
const FLAG_ID = 'control.nightlyAutoResetEnabled';
const LAST_ID = 'status.nightlyAutoReset.lastRun';
const DEBUG_ID = 'status.debug.nightlyAutoReset551';

const REQUIRED = {
  'status.phCalibration.lastPollTs': {type:'state',common:{name:'Zeitstempel letzte pH-Kalibrierungsabfrage',type:'number',role:'value.time',read:true,write:false,def:0},native:{}},
  'status.phCalibration.poolRaw': {type:'state',common:{name:'Pool pH Rohwert für Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}},
  'status.phCalibration.poolCorrected': {type:'state',common:{name:'Pool pH korrigierter Wert für Kalibrierung',type:'number',role:'value.ph',unit:'pH',read:true,write:false,def:0},native:{}}
};

function num(v){ if(v===undefined||v===null||v==='') return null; const n=Number(String(v).replace(',','.')); return Number.isFinite(n)?n:null; }
function boolValue(v){ if(v&&typeof v==='object'&&'val' in v)v=v.val; if(typeof v==='boolean')return v; if(typeof v==='number')return v!==0; return ['1','true','on','ein','yes','ja','aktiv','active'].includes(String(v??'').trim().toLowerCase()); }
function hhmmToMin(v){ const m=String(v||'').trim().match(/^(\d{1,2}):(\d{2})$/); if(!m)return null; const h=+m[1],mi=+m[2]; return h>=0&&h<=23&&mi>=0&&mi<=59?h*60+mi:null; }
function minToHhmm(v){ v=((v%1440)+1440)%1440; return `${String(Math.floor(v/60)).padStart(2,'0')}:${String(v%60).padStart(2,'0')}`; }
function dayKey(){ return ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()]; }
function applies(days){ const d=dayKey(),m=String(days||'daily').toLowerCase(); if(!m||m==='daily')return true; if(m==='mon_fri')return ['mon','tue','wed','thu','fri'].includes(d); if(m==='sat_sun')return ['sat','sun'].includes(d); return m===d; }
function windows(cfg){ const out=[]; const rows=Array.isArray(cfg.pumpSchedules)?cfg.pumpSchedules:[]; for(const r of rows){ if(!r||r.enabled===false||!applies(r.days))continue; const s=hhmmToMin(r.start),e=hhmmToMin(r.end); if(s!==null&&e!==null&&s!==e)out.push({s,e}); } if(out.length)return out; for(const [a,b] of [['pumpWindow1Start','pumpWindow1End'],['pumpWindow2Start','pumpWindow2End']]){ const s=hhmmToMin(cfg[a]),e=hhmmToMin(cfg[b]); if(s!==null&&e!==null&&s!==e)out.push({s,e}); } return out; }
function effective(cfg){ const step=Math.max(5,Math.min(240,Math.round(num(cfg.phCheckIntervalMin)||30))); const set=new Set(); for(const w of windows(cfg)){ const end=w.e>w.s?w.e:w.e+1440; for(let t=w.s+step;t<end;t+=step)set.add(minToHhmm(t)); } return {step,times:[...set].sort((a,b)=>hhmmToMin(a)-hhmmToMin(b))}; }
function patchVersion(v){ return String(v||'').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g,VERSION); }
function validTime(v){ const m=String(v||'').trim().match(/^(\d{1,2}):(\d{2})$/); if(!m)return null; const h=+m[1],mi=+m[2]; return h<=23&&mi<=59?`${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`:null; }
function nowTime(){const d=new Date();return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
function nowDay(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function tasmota(id){const m=String(id||'').match(/^(.*)\.ZbReceived_(0x[0-9A-Fa-f]+)_Power$/);return m?{cmd:`${m[1]}.ZbSend`,device:m[2]}:null;}

function install(adapter){
  if(!adapter||adapter.__restore551Installed)return adapter;
  adapter.__restore551Installed=true;
  let lastResetDay='';
  let resetting=false;

  const configuredLock=num(adapter.config&&adapter.config.phDoseLockMinutes)??30;

  async function ensureObjects(){
    for(const [id,obj] of Object.entries(REQUIRED)) await adapter.setObjectNotExistsAsync(id,obj);
    await adapter.setObjectNotExistsAsync(FLAG_ID,{type:'state',common:{name:'Nächtlicher Automatik-Reset',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
    await adapter.setObjectNotExistsAsync(LAST_ID,{type:'state',common:{name:'Letzter nächtlicher Automatik-Reset',type:'string',role:'text',read:true,write:false,def:''},native:{}});
    await adapter.setObjectNotExistsAsync(DEBUG_ID,{type:'state',common:{name:'Nacht-Reset Diagnose 0.5.51',type:'string',role:'text',read:true,write:false,def:''},native:{}});
  }

  function protectConfig(fn){
    return async function(...args){
      const cfg=adapter.config||{};
      const eff=effective(cfg);
      const goodTimes=eff.times.join(',');
      const descTimes=Object.getOwnPropertyDescriptor(cfg,'phCheckTimes');
      const descLock=Object.getOwnPropertyDescriptor(cfg,'phDoseLockMinutes');
      try{
        Object.defineProperty(cfg,'phCheckTimes',{configurable:true,enumerable:true,get:()=>goodTimes,set:()=>{}});
        Object.defineProperty(cfg,'phDoseLockMinutes',{configurable:true,enumerable:true,get:()=>configuredLock,set:()=>{}});
        cfg.phCheckIntervalMin=eff.step;
        return await fn(...args);
      } finally {
        if(descTimes)Object.defineProperty(cfg,'phCheckTimes',descTimes); else delete cfg.phCheckTimes;
        if(descLock)Object.defineProperty(cfg,'phDoseLockMinutes',descLock); else delete cfg.phDoseLockMinutes;
        cfg.phCheckTimes=goodTimes;
        cfg.phDoseLockMinutes=configuredLock;
      }
    };
  }

  if(typeof adapter.applyControlLogic==='function') adapter.applyControlLogic=protectConfig(adapter.applyControlLogic.bind(adapter));
  if(typeof adapter.renderVisFull==='function') adapter.renderVisFull=protectConfig(adapter.renderVisFull.bind(adapter));
  if(typeof adapter.forceImmediateRender==='function') adapter.forceImmediateRender=protectConfig(adapter.forceImmediateRender.bind(adapter));

  for(const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']){
    if(typeof adapter[name]!=='function')continue;
    const original=adapter[name].bind(adapter);
    adapter[name]=data=>{
      const cfg=adapter.config||{}; const eff=effective(cfg); const lock=num(cfg.phDoseLockMinutes)??configuredLock;
      const oldTimes=cfg.phCheckTimes,oldLock=cfg.phDoseLockMinutes;
      cfg.phCheckTimes=eff.times.join(','); cfg.phDoseLockMinutes=lock;
      try{return patchVersion(original({...(data||{}),adapterVersion:VERSION}));}
      finally{cfg.phCheckTimes=eff.times.join(',');cfg.phDoseLockMinutes=lock;}
    };
  }

  const rawSet=typeof adapter.setForeignStateAsync==='function'?adapter.setForeignStateAsync.bind(adapter):null;
  if(rawSet){ adapter.setForeignStateAsync=async function(id,value,...args){ const t=tasmota(id); if(!t)return rawSet(id,value,...args); return rawSet(t.cmd,JSON.stringify({Device:t.device,Send:{Power:boolValue(value)?1:0}}),false); }; }

  const rawLocal=typeof adapter.setStateIfChanged==='function'?adapter.setStateIfChanged.bind(adapter):null;
  if(rawLocal){ adapter.setStateIfChanged=async function(id,value,ack,...rest){ if(REQUIRED[id])await adapter.setObjectNotExistsAsync(id,REQUIRED[id]); if(typeof value==='string')value=patchVersion(value); return rawLocal(id,value,ack,...rest); }; }

  if(adapter.log&&typeof adapter.log.warn==='function'){
    const warn=adapter.log.warn.bind(adapter.log),info=typeof adapter.log.info==='function'?adapter.log.info.bind(adapter.log):warn;
    adapter.log.warn=function(msg,...args){const s=String(msg||'');if(s.includes('[ALERT] Kein aktiver Versandkanal'))return;if(s.includes('[CHLOR-OWNER')&&s.includes('unerwartet AUS')&&s.includes('wiederhergestellt'))return info(s,...args);return warn(s,...args);};
  }

  async function off(id,mode){ if(!id)return; const t=tasmota(id); if(t)return rawSet(t.cmd,JSON.stringify({Device:t.device,Send:{Power:0}}),false); let obj=null;try{obj=await adapter.getForeignObjectAsync(id);}catch{} if(obj&&obj.common&&obj.common.write===false)return; const v=String(mode||'').toLowerCase()==='num01'||(obj&&obj.common&&obj.common.type==='number')?0:false; return rawSet(id,v,false); }
  async function reset(){ if(resetting||adapter.config&&adapter.config.standbyModeEnabled===true)return; resetting=true; try{const c=adapter.config||{};await off(c.chlorinatorSocketStateId,c.chlorinatorWriteMode);await off(c.phPumpSocketStateId,c.phPumpWriteMode);await off(c.heatpumpPowerStateId,'');await off(c.circulationPumpSocketStateId,c.circulationPumpWriteMode);await new Promise(r=>setTimeout(r,900));for(const id of ['control.auto.pump','control.auto.chlor','control.auto.ph','control.auto.heatpump']){try{const s=await adapter.getStateAsync(id);if(!s||!boolValue(s.val))await adapter.setStateAsync(id,true,false);}catch{}}await adapter.setStateIfChanged(LAST_ID,new Date().toLocaleString('de-DE'),true);}finally{resetting=false;} }
  async function checkReset(){const f=await adapter.getStateAsync(FLAG_ID);if(!f||!boolValue(f.val))return;const t=validTime(adapter.config&&adapter.config.nightlyAutoResetTime)||'22:00';if(nowTime()!==t)return;const d=nowDay();if(lastResetDay===d)return;lastResetDay=d;await reset();}

  adapter.on('ready',()=>{
    ensureObjects().catch(()=>{});
    const h=adapter.trackTimeout(setTimeout(async()=>{
      adapter.pendingTimeouts.delete(h);
      if(adapter.isShuttingDown)return;
      try{
        adapter.lastRenderSignature=''; adapter.lastRenderAt=0;
        if(Object.prototype.hasOwnProperty.call(adapter,'__ipadLastFullRender056'))adapter.__ipadLastFullRender056=0;
        if(typeof adapter.forceImmediateRender==='function')await adapter.forceImmediateRender();
        else if(typeof adapter.renderVisFull==='function')await adapter.renderVisFull();
      }catch(e){if(adapter.log)adapter.log.error(`[VIS-RESTORE 0.5.51] ${e.message||e}`);}
    },1200));
    const timer=setInterval(()=>{if(!adapter.isShuttingDown)checkReset().catch(()=>{});},15000);if(typeof adapter.trackInterval==='function')adapter.trackInterval(timer);
  });
  ensureObjects().catch(()=>{});
  return adapter;
}

function createAdapter(options={}){return install(createBase(options));}
if(require.main!==module)module.exports=createAdapter;else createAdapter();

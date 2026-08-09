'use strict';

// 0.5.46: pH-Pruefintervall und Sperrzeit nach Dosierung voneinander trennen.
// Direkte Basis ist 0.5.38, damit keine aeltere Intervall-Schicht die Werte
// wieder koppelt. Start/Ende eines Pumpenfensters bleiben ausgeschlossen.
// Zusaetzlich ist der vis.htmlPhCalibration-Objektguard aus 0.5.45 enthalten.
const createBase = require('./main-ipadmini-final-538.js');

const VERSION = 'v0.5.46';
const DEFAULT_INTERVAL_MIN = 30;
const VIS_STATES = ['vis.htmlTablet','vis.widgetTablet','vis.htmlPhone','vis.widgetPhone','vis.htmlIpadMini'];
const PH_CAL_VIS_ID = 'vis.htmlPhCalibration';

function num(value){
  if(value===undefined||value===null||value==='') return null;
  const n=Number(String(value).trim().replace(',','.'));
  return Number.isFinite(n)?n:null;
}
function hhmmToMin(value){
  const m=String(value||'').trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const h=Number(m[1]),min=Number(m[2]);
  return h>=0&&h<=23&&min>=0&&min<=59?h*60+min:null;
}
function minToHhmm(total){
  const v=((Number(total)%1440)+1440)%1440;
  return `${String(Math.floor(v/60)).padStart(2,'0')}:${String(v%60).padStart(2,'0')}`;
}
function todayKey(){ return ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()]; }
function scheduleAppliesToday(days){
  const key=todayKey();
  const mode=String(days||'daily').trim().toLowerCase();
  if(!mode||mode==='daily') return true;
  if(mode==='mon_fri') return ['mon','tue','wed','thu','fri'].includes(key);
  if(mode==='sat_sun') return ['sat','sun'].includes(key);
  return mode===key;
}
function normalizeWindow(startText,endText){
  const start=hhmmToMin(startText),end=hhmmToMin(endText);
  if(start===null||end===null||start===end) return null;
  return {start,end};
}
function collectTodayWindows(cfg){
  const windows=[];
  const schedules=Array.isArray(cfg&&cfg.pumpSchedules)?cfg.pumpSchedules:[];
  for(const row of schedules){
    if(!row||row.enabled===false||!scheduleAppliesToday(row.days)) continue;
    const w=normalizeWindow(row.start,row.end);
    if(w) windows.push(w);
  }
  if(windows.length) return windows;
  for(const [s,e] of [['pumpWindow1Start','pumpWindow1End'],['pumpWindow2Start','pumpWindow2End']]){
    const w=normalizeWindow(cfg&&cfg[s],cfg&&cfg[e]);
    if(w) windows.push(w);
  }
  return windows;
}
function addWindowTimes(target,window,step){
  // Erst nach einem vollen Intervall pruefen; Pumpenende ist kein Pruefpunkt.
  if(window.end>window.start){
    for(let t=window.start+step;t<window.end;t+=step) target.add(minToHhmm(t));
    return;
  }
  const endExtended=window.end+1440;
  for(let t=window.start+step;t<endExtended;t+=step) target.add(minToHhmm(t));
}
function buildEffectiveTimes(cfg){
  const configured=num(cfg&&cfg.phCheckIntervalMin);
  const interval=configured!==null&&configured>=5?Math.max(5,Math.min(240,Math.round(configured))):DEFAULT_INTERVAL_MIN;
  const set=new Set();
  for(const w of collectTodayWindows(cfg||{})) addWindowTimes(set,w,interval);
  return {interval,times:Array.from(set).sort((a,b)=>hhmmToMin(a)-hhmmToMin(b))};
}
function applyEffectiveConfig(adapter){
  if(!adapter||!adapter.config) return {interval:DEFAULT_INTERVAL_MIN,times:[]};
  const eff=buildEffectiveTimes(adapter.config);
  adapter.config.phCheckIntervalMin=eff.interval;
  adapter.config.phCheckTimes=eff.times.join(',');
  // WICHTIG 0.5.46: phDoseLockMinutes wird absichtlich NICHT veraendert.
  return eff;
}
function patchVersion(value){ return String(value||'').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g,VERSION); }
function nextCheck(adapter){
  const eff=applyEffectiveConfig(adapter);
  const now=new Date();
  const nowMin=now.getHours()*60+now.getMinutes();
  for(const t of eff.times){ const m=hhmmToMin(t); if(m!==null&&m>=nowMin) return t; }
  return null;
}
function compactDoseText(text){
  return String(text||'').replace(/(\d+)\s*s\s*\/\s*([\d.,]+)\s*ml\s*·\s*(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s*(\d{1,2}):(\d{2})(?::\d{2})?/g,(_a,sec,ml,d,mo,y,h,mi)=>{
    const now=new Date();
    const same=now.getDate()===Number(d)&&now.getMonth()+1===Number(mo)&&now.getFullYear()===Number(y);
    const when=same?`heute ${String(h).padStart(2,'0')}:${mi} Uhr`:`${String(d).padStart(2,'0')}.${String(mo).padStart(2,'0')}. ${String(h).padStart(2,'0')}:${mi} Uhr`;
    return `${ml} ml · ${sec} s · ${when}`;
  });
}
function patchPhInfo(adapter,value){
  let text=patchVersion(value);
  if(!text) return text;
  const eff=applyEffectiveConfig(adapter);
  const raw=eff.times.join(',');
  const next=nextCheck(adapter);
  const compact=next?`alle ${eff.interval} Min · nächster Check ${next} Uhr`:`alle ${eff.interval} Min · heute kein weiterer Check`;
  if(raw) text=text.split(raw).join(compact);
  text=text.replace(/pH Zeiten/g,'pH Prüfung');
  return compactDoseText(text);
}

function install(adapter){
  if(!adapter||adapter.__phIndependent546Installed) return adapter;
  adapter.__phIndependent546Installed=true;

  let ensurePromise=null;
  async function ensurePhCalibrationVisObject(){
    if(!ensurePromise){
      ensurePromise=adapter.setObjectNotExistsAsync(PH_CAL_VIS_ID,{
        type:'state',common:{name:'pH-Kalibrierung VIS HTML',type:'string',role:'html',read:true,write:false,def:''},native:{}
      }).catch(error=>{ ensurePromise=null; throw error; });
    }
    return ensurePromise;
  }

  const originalSetStateIfChanged=adapter.setStateIfChanged.bind(adapter);
  adapter.setStateIfChanged=async function(id,value,ack,...rest){
    if(id===PH_CAL_VIS_ID) await ensurePhCalibrationVisObject();
    if(typeof value==='string') value=patchVersion(value);
    return originalSetStateIfChanged(id,value,ack,...rest);
  };

  if(typeof adapter.setStateAsync==='function'){
    const originalSetStateAsync=adapter.setStateAsync.bind(adapter);
    adapter.setStateAsync=async function(id,...args){
      if(id===PH_CAL_VIS_ID) await ensurePhCalibrationVisObject();
      return originalSetStateAsync(id,...args);
    };
  }

  async function patchExisting(){
    for(const id of VIS_STATES){
      try{
        const st=await adapter.getStateAsync(id);
        const cur=String(st&&st.val||'');
        if(!cur) continue;
        const next=patchPhInfo(adapter,cur);
        if(next!==cur) await originalSetStateIfChanged(id,next,true);
      }catch(e){
        if(!adapter.isDbClosedError(e)&&adapter.log) adapter.log.error(`[0.5.46 VIS] ${id}: ${e.message||e}`);
      }
    }
  }

  if(typeof adapter.applyControlLogic==='function'){
    const original=adapter.applyControlLogic.bind(adapter);
    adapter.applyControlLogic=async function(...args){
      applyEffectiveConfig(adapter);
      return original(...args);
    };
  }

  for(const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']){
    if(typeof adapter[name]!=='function') continue;
    const original=adapter[name].bind(adapter);
    adapter[name]=data=>{
      applyEffectiveConfig(adapter);
      return patchPhInfo(adapter,original({...(data||{}),adapterVersion:VERSION}));
    };
  }

  if(typeof adapter.renderVisFull==='function'){
    const original=adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull=async function(...args){
      applyEffectiveConfig(adapter);
      const r=await original(...args);
      await patchExisting();
      return r;
    };
  }

  adapter.on('ready',()=>{
    ensurePhCalibrationVisObject().catch(error=>{
      if(adapter.log) adapter.log.error(`[0.5.46] ${PH_CAL_VIS_ID} konnte nicht angelegt werden: ${error.message||error}`);
    });
    const handle=adapter.trackTimeout(setTimeout(async()=>{
      adapter.pendingTimeouts.delete(handle);
      if(adapter.isShuttingDown) return;
      const eff=applyEffectiveConfig(adapter);
      const lock=num(adapter.config&&adapter.config.phDoseLockMinutes);
      try{
        await adapter.setObjectNotExistsAsync('status.debug.phInterval546',{
          type:'state',common:{name:'pH Intervall und Sperrzeit 0.5.46',type:'string',role:'text',read:true,write:false,def:''},native:{}
        });
        await adapter.setStateIfChanged('status.debug.phInterval546',`AKTIV · Prüfintervall ${eff.interval} min · Sperrzeit ${lock===null?'nicht gesetzt':lock+' min'} · Zeiten ${eff.times.join(',')||'keine'}`,true);
      }catch{}
      await patchExisting();
    },800));
  });

  return adapter;
}

function createAdapter(options={}){ return install(createBase(options)); }
if(require.main!==module) module.exports=createAdapter;
else createAdapter();

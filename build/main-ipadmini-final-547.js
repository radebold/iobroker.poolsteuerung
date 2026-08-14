'use strict';

// 0.5.47: Naechtlicher Automatik-Reset.
// - eigener Flag-Schalter in allen VIS-Ausgaben
// - Uhrzeit ueber native.nightlyAutoResetTime konfigurierbar
// - bei aktivem Standby wird der Reset komplett uebersprungen
// - Reihenfolge: alle vier Geraete AUS -> kurze Pause -> vier Automatikschalter EIN
// - TasmotaZB ZbReceived_*_Power wird niemals direkt beschrieben; stattdessen ZbSend.
const createBase = require('./main-ipadmini-final-546.js');

const VERSION = 'v0.5.47';
const FLAG_ID = 'control.nightlyAutoResetEnabled';
const LAST_ID = 'status.nightlyAutoReset.lastRun';
const DEBUG_ID = 'status.debug.nightlyAutoReset547';
const VIS_STATES = ['vis.htmlTablet','vis.widgetTablet','vis.htmlPhone','vis.widgetPhone','vis.htmlIpadMini'];

function boolValue(value){
  if(typeof value==='boolean') return value;
  if(typeof value==='number') return value!==0;
  return ['true','1','on','ein','yes','ja','active','aktiv'].includes(String(value??'').trim().toLowerCase());
}
function patchVersion(value){
  return String(value||'').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g,VERSION);
}
function validTime(value){
  const m=String(value||'').trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const h=Number(m[1]),min=Number(m[2]);
  if(h<0||h>23||min<0||min>59) return null;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}
function localDateKey(date=new Date()){
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function localTime(date=new Date()){
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}
function esc(value){
  return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function visToggleHtml(namespace, enabled, time){
  const ns=JSON.stringify(String(namespace||'poolsteuerung.0'));
  const stateId=JSON.stringify(`${namespace}.${FLAG_ID}`);
  return `<!--NIGHT-AUTO-RESET-547-START--><style data-night-reset-547="1">
.night-reset-flag{position:fixed;z-index:2147483645;right:12px;bottom:10px;display:flex;align-items:center;gap:7px;height:30px;padding:3px 9px 3px 5px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(5,20,35,.91);box-shadow:0 5px 16px rgba(0,0,0,.28);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#b8c8d8;font-size:9px;font-weight:850;cursor:pointer;user-select:none}.night-reset-flag .nr-dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:#6f8194;color:#fff;font-size:10px;box-shadow:0 0 0 3px rgba(111,129,148,.12)}.night-reset-flag.on{color:#bff4c9;border-color:rgba(101,224,124,.28);background:rgba(16,58,34,.90)}.night-reset-flag.on .nr-dot{background:#63df7c;box-shadow:0 0 0 3px rgba(99,223,124,.14),0 0 11px rgba(99,223,124,.55)}.night-reset-flag.busy{opacity:.65;pointer-events:none}@media(max-width:600px){.night-reset-flag{right:7px;bottom:7px;height:27px;font-size:8px}.night-reset-flag .nr-dot{width:17px;height:17px}}
</style><button type="button" class="night-reset-flag ${enabled?'on':''}" data-night-reset-547="1" aria-pressed="${enabled?'true':'false'}"><span class="nr-dot">${enabled?'✓':'○'}</span><span>Nacht-Reset ${enabled?'AN':'AUS'} · ${esc(time)}</span></button><script data-night-reset-script-547="1">(function(){var n=${ns},id=${stateId};function api(){var w=[window];try{w.push(window.parent)}catch(e){}try{w.push(window.top)}catch(e){}for(var i=0;i<w.length;i++)try{if(w[i]&&w[i].vis)return w[i].vis}catch(e){}return null}async function setState(k,v){var a=api();if(!a)return false;try{if(typeof a.setValue==='function'){var r=a.setValue(k,v);if(r&&r.then)await r;return true}}catch(e){}try{if(a.conn&&typeof a.conn.setState==='function'){var q=a.conn.setState(k,v);if(q&&q.then)await q;return true}}catch(e){}return false}document.addEventListener('click',async function(e){var b=e.target&&e.target.closest?e.target.closest('[data-night-reset-547]'):null;if(!b||b.classList.contains('busy'))return;e.preventDefault();e.stopPropagation();var on=b.classList.contains('on');b.classList.add('busy');var ok=await setState(id,!on);if(!ok)b.classList.remove('busy')},true)})();</script><!--NIGHT-AUTO-RESET-547-END-->`;
}
function stripVisToggle(html){
  return String(html||'')
    .replace(/<!--NIGHT-AUTO-RESET-547-START-->[\s\S]*?<!--NIGHT-AUTO-RESET-547-END-->/gi,'')
    .replace(/<style\b[^>]*data-night-reset-547="1"[^>]*>[\s\S]*?<\/style>/gi,'')
    .replace(/<script\b[^>]*data-night-reset-script-547="1"[^>]*>[\s\S]*?<\/script>/gi,'')
    .replace(/<button\b[^>]*data-night-reset-547="1"[^>]*>[\s\S]*?<\/button>/gi,'');
}
function patchVisToggle(adapter,html,enabled){
  let text=patchVersion(stripVisToggle(html));
  if(!text) return text;
  const time=validTime(adapter.config&&adapter.config.nightlyAutoResetTime)||'22:00';
  const toggle=visToggleHtml(adapter.namespace,enabled,time);
  if(/<\/body>/i.test(text)) return text.replace(/<\/body>/i,`${toggle}</body>`);
  return `${text}${toggle}`;
}

function install(adapter){
  if(!adapter||adapter.__nightReset547Installed) return adapter;
  adapter.__nightReset547Installed=true;
  let lastAttemptDate='';
  let running=false;

  async function ensureStates(){
    if(typeof adapter.ensureState==='function'){
      await adapter.ensureState(FLAG_ID,'boolean','switch',false,true);
      await adapter.ensureState(LAST_ID,'string','text','',false);
      await adapter.ensureState(DEBUG_ID,'string','text','',false);
    }else{
      await adapter.setObjectNotExistsAsync(FLAG_ID,{type:'state',common:{name:'Naechtlicher Automatik-Reset',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
      await adapter.setObjectNotExistsAsync(LAST_ID,{type:'state',common:{name:'Letzter naechtlicher Automatik-Reset',type:'string',role:'text',read:true,write:false,def:''},native:{}});
      await adapter.setObjectNotExistsAsync(DEBUG_ID,{type:'state',common:{name:'Nacht-Reset Diagnose 0.5.47',type:'string',role:'text',read:true,write:false,def:''},native:{}});
    }
  }
  async function debug(text){
    try{ await adapter.setStateIfChanged(DEBUG_ID,text,true); }catch{}
  }
  async function flagEnabled(){
    try{ const s=await adapter.getStateAsync(FLAG_ID); return !!s&&boolValue(s.val); }catch{return false;}
  }

  async function getObject(id){
    try{ return await adapter.getForeignObjectAsync(id); }catch{return null;}
  }
  function tasmotaTarget(id){
    try{
      if(typeof adapter.getTasmotaZigbeeWriteTarget==='function'){
        const t=adapter.getTasmotaZigbeeWriteTarget(id);
        if(t&&t.cmdId&&t.device) return {cmdId:String(t.cmdId),device:String(t.device)};
      }
    }catch{}
    const m=String(id||'').match(/^(.*)\.ZbReceived_(0x[0-9A-Fa-f]+)_Power$/);
    return m?{cmdId:`${m[1]}.ZbSend`,device:m[2]}:null;
  }
  async function switchOff(id,writeMode,label){
    id=String(id||'').trim();
    if(!id) return `${label}: nicht konfiguriert`;
    const t=tasmotaTarget(id);
    if(t){
      const payload=JSON.stringify({Device:t.device,Send:{Power:0}});
      await adapter.setForeignStateAsync(t.cmdId,payload,false);
      return `${label}: AUS via ZbSend`;
    }
    const obj=await getObject(id);
    if(obj&&obj.common&&obj.common.write===false) return `${label}: NICHT geschaltet (State read-only)`;
    const type=obj&&obj.common&&obj.common.type;
    const value=String(writeMode||'').toLowerCase()==='num01'||type==='number'?0:false;
    await adapter.setForeignStateAsync(id,value,false);
    return `${label}: AUS`;
  }

  async function discoverAutoStates(){
    const prefix=`${adapter.namespace}.control.auto.`;
    let ids=[];
    try{
      if(typeof adapter.getObjectViewAsync==='function'){
        const view=await adapter.getObjectViewAsync('system','state',{startkey:prefix,endkey:`${prefix}\u9999`});
        ids=(view&&Array.isArray(view.rows)?view.rows:[]).map(r=>String(r.id||'')).filter(Boolean);
      }
    }catch{}
    const candidates=[
      'control.auto.pump','control.auto.circulation','control.auto.circulationPump','control.auto.filterPump',
      'control.auto.ph','control.auto.phDose','control.auto.phPump',
      'control.auto.chlor','control.auto.orp','control.auto.chlorinator',
      'control.auto.heat','control.auto.heatpump','control.auto.heating'
    ];
    for(const local of candidates){
      try{ const obj=await adapter.getObjectAsync(local); if(obj) ids.push(`${adapter.namespace}.${local}`); }catch{}
    }
    ids=[...new Set(ids)];
    const groups={pump:null,ph:null,chlor:null,heat:null};
    for(const id of ids){
      const x=id.toLowerCase();
      if(!groups.ph&&/(\.ph(?:\.|$)|phdose|phpump)/.test(x)) groups.ph=id;
      else if(!groups.chlor&&/(chlor|orp)/.test(x)) groups.chlor=id;
      else if(!groups.heat&&/(heat|heiz|waerm|wärm)/.test(x)) groups.heat=id;
      else if(!groups.pump&&/(pump|circulation|umwael|umwäl|filter)/.test(x)) groups.pump=id;
    }
    return groups;
  }
  async function enableAutomatics(){
    const groups=await discoverAutoStates();
    const result=[];
    for(const [name,id] of Object.entries(groups)){
      if(!id){ result.push(`${name}: Automatik-State nicht gefunden`); continue; }
      const local=id.startsWith(`${adapter.namespace}.`)?id.slice(adapter.namespace.length+1):id;
      try{
        const s=await adapter.getStateAsync(local);
        if(!s||!boolValue(s.val)) await adapter.setStateAsync(local,true,false);
        result.push(`${name}: Automatik EIN`);
      }catch(e){ result.push(`${name}: Fehler ${e.message||e}`); }
    }
    return result;
  }
  async function runNightReset(reason){
    if(running||adapter.isShuttingDown) return;
    running=true;
    try{
      if(adapter.config&&adapter.config.standbyModeEnabled===true){
        await debug(`ÜBERSPRUNGEN · ${reason} · Standby aktiv`);
        return;
      }
      const cfg=adapter.config||{};
      const off=[];
      for(const [id,mode,label] of [
        [cfg.chlorinatorSocketStateId,cfg.chlorinatorWriteMode,'Chlorinator'],
        [cfg.phPumpSocketStateId,cfg.phPumpWriteMode,'pH-Dosierpumpe'],
        [cfg.heatpumpPowerStateId,'','Wärmepumpe'],
        [cfg.circulationPumpSocketStateId,cfg.circulationPumpWriteMode,'Umwälzpumpe']
      ]){
        try{ off.push(await switchOff(id,mode,label)); }
        catch(e){ off.push(`${label}: Fehler ${e.message||e}`); }
      }
      // Erst sicher AUS, dann Automatikfreigaben wieder setzen.
      await new Promise(resolve=>setTimeout(resolve,900));
      const autos=await enableAutomatics();
      const stamp=new Date().toLocaleString('de-DE');
      await adapter.setStateIfChanged(LAST_ID,stamp,true);
      await debug(`AUSGEFÜHRT · ${reason} · ${off.join(' | ')} · ${autos.join(' | ')}`);
      if(adapter.log) adapter.log.info(`[NACHT-RESET 0.5.47] ${off.join(' | ')} · ${autos.join(' | ')}`);
    }finally{ running=false; }
  }
  async function checkSchedule(reason='Timer'){
    if(!(await flagEnabled())) return;
    const time=validTime(adapter.config&&adapter.config.nightlyAutoResetTime)||'22:00';
    const now=new Date();
    if(localTime(now)!==time) return;
    const day=localDateKey(now);
    if(lastAttemptDate===day) return;
    lastAttemptDate=day;
    await runNightReset(`${reason} ${time}`);
  }

  async function patchExistingVis(){
    const enabled=await flagEnabled();
    for(const id of VIS_STATES){
      try{
        const s=await adapter.getStateAsync(id);
        const current=String(s&&s.val||'');
        if(!current) continue;
        const next=patchVisToggle(adapter,current,enabled);
        if(next!==current) await adapter.setStateIfChanged(id,next,true);
      }catch(e){ if(!adapter.isDbClosedError(e)&&adapter.log) adapter.log.warn(`[0.5.47 VIS] ${id}: ${e.message||e}`); }
    }
  }

  for(const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']){
    if(typeof adapter[name]!=='function') continue;
    const original=adapter[name].bind(adapter);
    adapter[name]=data=>patchVersion(original({...(data||{}),adapterVersion:VERSION}));
  }
  if(typeof adapter.renderVisFull==='function'){
    const originalRender=adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull=async function(...args){
      const r=await originalRender(...args);
      await patchExistingVis();
      return r;
    };
  }

  adapter.on('stateChange',(id,state)=>{
    if(!state||adapter.isShuttingDown) return;
    const prefix=`${adapter.namespace}.`;
    const local=String(id).startsWith(prefix)?String(id).slice(prefix.length):String(id);
    if(local!==FLAG_ID) return;
    const h=adapter.trackTimeout(setTimeout(async()=>{
      adapter.pendingTimeouts.delete(h);
      if(!adapter.isShuttingDown) await patchExistingVis();
    },120));
  });

  adapter.on('ready',()=>{
    const h=adapter.trackTimeout(setTimeout(async()=>{
      adapter.pendingTimeouts.delete(h);
      if(adapter.isShuttingDown) return;
      await ensureStates();
      try{ adapter.subscribeStates(FLAG_ID); }catch{}
      await debug(`BEREIT · Uhrzeit ${validTime(adapter.config&&adapter.config.nightlyAutoResetTime)||'22:00'} · Standby ${adapter.config&&adapter.config.standbyModeEnabled===true?'aktiv':'aus'}`);
      await patchExistingVis();
      await checkSchedule('Ready');
    },900));
  });

  const timer=setInterval(()=>{ if(!adapter.isShuttingDown) checkSchedule('Timer').catch(()=>{}); },15000);
  if(typeof adapter.trackInterval==='function') adapter.trackInterval(timer);

  return adapter;
}

function createAdapter(options={}){ return install(createBase(options)); }
if(require.main!==module) module.exports=createAdapter;
else createAdapter();

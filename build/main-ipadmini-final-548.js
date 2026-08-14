'use strict';

// 0.5.48: Log-/Aktor-Hotfix.
// - ZbReceived_*_Power ist immer Feedback/read-only und wird nie direkt beschrieben.
// - Schreibversuche werden auf TasmotaZB.ZbSend umgeleitet.
// - bewusst nicht konfigurierte Alert-Versandkanaele erzeugen keine WARN-Flut.
// - erwartete CHLOR-OWNER Selbstheilung wird als info statt warn protokolliert.
const createBase = require('./main-ipadmini-final-547.js');
const VERSION='v0.5.48';

function unwrap(v){return v&&typeof v==='object'&&Object.prototype.hasOwnProperty.call(v,'val')?v.val:v;}
function bool(v){v=unwrap(v);if(typeof v==='boolean')return v;if(typeof v==='number')return v!==0;return ['1','true','on','ein'].includes(String(v??'').trim().toLowerCase());}
function target(id){const m=String(id||'').match(/^(.*)\.ZbReceived_(0x[0-9A-Fa-f]+)_Power$/);return m?{cmd:`${m[1]}.ZbSend`,device:m[2]}:null;}
function version(v){return String(v||'').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g,VERSION);}

function install(adapter){
 if(!adapter||adapter.__fix548)return adapter;adapter.__fix548=true;
 const rawSet=typeof adapter.setForeignStateAsync==='function'?adapter.setForeignStateAsync.bind(adapter):null;
 const rawChanged=typeof adapter.setForeignStateChangedAsync==='function'?adapter.setForeignStateChangedAsync.bind(adapter):null;
 async function safeWrite(raw,id,value,args){
   const t=target(id);
   if(!t)return raw(id,value,...args);
   const payload=JSON.stringify({Device:t.device,Send:{Power:bool(value)?1:0}});
   if(adapter.log&&adapter.config&&adapter.config.debugMode)adapter.log.debug(`[ZB-GUARD 0.5.48] ${id} -> ${t.cmd} ${payload}`);
   // Direkt den vor Installation gebundenen Writer verwenden, damit keine rekursive Umleitung entsteht.
   return rawSet(t.cmd,payload,false);
 }
 if(rawSet)adapter.setForeignStateAsync=function(id,value,...args){return safeWrite(rawSet,id,value,args);};
 if(rawChanged)adapter.setForeignStateChangedAsync=function(id,value,...args){return safeWrite(rawChanged,id,value,args);};

 // Erwartete/konfigurationsbedingte Meldungen nicht als WARN behandeln.
 if(adapter.log&&typeof adapter.log.warn==='function'){
   const oldWarn=adapter.log.warn.bind(adapter.log);
   const info=typeof adapter.log.info==='function'?adapter.log.info.bind(adapter.log):oldWarn;
   adapter.log.warn=function(msg,...args){
     const s=String(msg||'');
     if(s.includes('[ALERT] Kein aktiver Versandkanal')||s.includes('[ALERT] Kein aktiver Versandkanal oder Versand fehlgeschlagen')){
       if(adapter.config&&adapter.config.debugMode)info(`[ALERT-INFO] ${s.replace(/^\[ALERT\]\s*/,'')}`,...args);
       return;
     }
     if(s.includes('[CHLOR-OWNER')&&s.includes('unerwartet AUS')&&s.includes('wiederhergestellt')) return info(version(s),...args);
     return oldWarn(version(s),...args);
   };
 }
 for(const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']){
   if(typeof adapter[name]!=='function')continue;const fn=adapter[name].bind(adapter);adapter[name]=d=>version(fn({...d,adapterVersion:VERSION}));
 }
 return adapter;
}
function createAdapter(options={}){return install(createBase(options));}
if(require.main!==module)module.exports=createAdapter;else createAdapter();

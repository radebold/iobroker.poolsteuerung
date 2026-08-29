'use strict';

// 0.5.76: EIN finale VIS-Schicht auf Basis 0.5.73.
// Kein 0.5.74/0.5.75-Guard in der Vererbung. Diese Datei besitzt zugleich
// die sichtbare VIS-Version und die 24h-Pooltemperaturkurve der Phone-VIS.
// Keine Aenderung an Karten-/Seitenhoehen oder Regelungslogik.
const createBase = require('./main-ipadmini-final-573.js');

const VERSION = 'v0.5.76';
const VIS_IDS = new Set(['vis.htmlTablet','vis.widgetTablet','vis.htmlPhone','vis.widgetPhone','vis.htmlIpadMini']);
const PHONE_IDS = new Set(['vis.htmlPhone','vis.widgetPhone']);
const CACHE_MS = 60000;

function localId(adapter,id){
  const s=String(id||'');
  const p=`${adapter.namespace}.`;
  return s.startsWith(p)?s.slice(p.length):s;
}
function normalizeVersion(v){
  return String(v||'').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g,VERSION);
}
function detectVersions(v){
  const m=String(v||'').match(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g)||[];
  return [...new Set(m)];
}
function cleanOldCurve(html){
  let out=String(html||'');
  out=out.replace(/<style data-phone-temp-(?:568|569|570|571|572|573|575|576)="1">[\s\S]*?<\/style>/g,'');
  out=out.replace(/<div class="(?:temp-inline-(?:568|569|570)|ps-temp-inline-(?:571|572)|phone-temp-inline-(?:572|573|575|576))">[\s\S]*?<\/div>/g,'');
  return out;
}
function makeSvg(adapter,values){
  if(typeof adapter.buildSparklineSvgFromValues==='function'){
    const svg=String(adapter.buildSparklineSvgFromValues(values,'sparkline-temp','24h')||'');
    if(svg.includes('<svg')) return svg;
  }
  const pts=(Array.isArray(values)?values:[]).map(v=>{
    const n=Number(v&&typeof v==='object'&&'val' in v?v.val:v);
    return Number.isFinite(n)?n:null;
  }).filter(v=>v!==null);
  if(pts.length<2)return '';
  const min=Math.min(...pts),max=Math.max(...pts),span=Math.max(0.1,max-min);
  const w=160,h=32,p=2;
  const d=pts.map((v,i)=>{
    const x=p+(w-2*p)*(i/(pts.length-1));
    const y=h-p-(h-2*p)*((v-min)/span);
    return `${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
}
function injectCurve(html,svg){
  let out=normalizeVersion(cleanOldCurve(html));
  const curve=String(svg||'').trim();
  if(!out||!curve.includes('<svg')) return {html:out,inserted:false,reason:'kein SVG'};
  const css=`<style data-phone-temp-576="1">
.phone-temp-inline-576{height:32px;flex:1 1 120px;min-width:90px;max-width:170px;margin-left:12px;overflow:hidden;align-self:center;pointer-events:none}
.phone-temp-inline-576 svg{display:block!important;width:100%!important;height:32px!important;max-width:none!important;overflow:hidden!important}
.phone-temp-inline-576 path{fill:none!important;stroke:#76d7ff!important;stroke-width:1!important;stroke-linecap:round!important;stroke-linejoin:round!important}
.ph-info-right-568{margin-left:auto!important;margin-right:0!important;align-self:flex-end!important;justify-self:end!important}
</style>`;
  out=out.includes('</head>')?out.replace('</head>',css+'</head>'):css+out;
  let inserted=false;
  out=out.replace(/(<div class="temp-row">\s*<div class="temp">[\s\S]*?<\/div>\s*<div class="unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,(_m,a,b)=>{inserted=true;return `${a}<div class="phone-temp-inline-576">${curve}</div>${b}`;});
  if(!inserted){
    out=out.replace(/(<div class="ps-tempRow">\s*<div class="ps-temp">[\s\S]*?<\/div>\s*<div class="ps-unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,(_m,a,b)=>{inserted=true;return `${a}<div class="phone-temp-inline-576">${curve}</div>${b}`;});
  }
  return {html:out,inserted,reason:inserted?'OK':'Temperaturzeile nicht gefunden'};
}

function install(adapter){
  if(!adapter||adapter.__vis576Installed)return adapter;
  adapter.__vis576Installed=true;

  const rawSetStateAsync=adapter.setStateAsync.bind(adapter);
  let cache={ts:0,svg:'',count:0,source:'',error:''};
  let loading=null;
  let lastInsert='noch kein Phone-Write';
  let lastLegacy='';
  let rewriteCount=0;

  async function loadCurve(force=false){
    const now=Date.now();
    if(!force&&cache.svg&&now-cache.ts<CACHE_MS)return cache;
    if(loading)return loading;
    loading=(async()=>{
      const stateId=String((adapter.config&&adapter.config.waterTempStateId)||'').trim();
      const historyInstance=String((adapter.config&&adapter.config.trendHistoryInstance)||'history.0').trim()||'history.0';
      const next={ts:Date.now(),svg:'',count:0,source:`${historyInstance} · ${stateId||'kein waterTempStateId'}`,error:''};
      try{
        if(!stateId)throw new Error('waterTempStateId ist leer');
        let values=[];
        if(typeof adapter.fetchHistoryValues==='function'){
          const end=Date.now();
          values=await Promise.race([
            adapter.fetchHistoryValues(stateId,end-24*60*60*1000,end,'average',96),
            new Promise(resolve=>setTimeout(()=>resolve([]),8000))
          ]);
        }
        next.count=Array.isArray(values)?values.length:0;
        if(next.count)next.svg=makeSvg(adapter,values);
        if(!next.count)next.error='History lieferte 0 Werte';
        else if(!next.svg.includes('<svg'))next.error='Historywerte vorhanden, aber SVG leer';
      }catch(e){next.error=String((e&&e.message)||e||'unbekannter Fehler');}
      cache=next;
      return cache;
    })().finally(()=>{loading=null;});
    return loading;
  }

  // EIN finaler Schreibpunkt fuer Version + Phone-Kurve.
  adapter.setStateAsync=async function setStateAsync576(id,value,ack,...rest){
    const local=localId(adapter,id);
    if(VIS_IDS.has(local)&&typeof value==='string'){
      const before=String(value);
      const old=detectVersions(before).filter(v=>v!==VERSION);
      if(old.length){lastLegacy=old.join(', ');rewriteCount++;}
      let next=normalizeVersion(before);
      if(PHONE_IDS.has(local)){
        const curve=await loadCurve(false);
        const patched=injectCurve(next,curve.svg);
        next=patched.html;
        lastInsert=patched.inserted?`eingefuegt · ${curve.count} Werte`:`${patched.reason} · ${curve.count} Werte`;
      }
      return rawSetStateAsync(id,next,ack,...rest);
    }
    return rawSetStateAsync(id,value,ack,...rest);
  };

  // Auch Builderdaten bereits auf 0.5.76 setzen; final verbindlich bleibt setStateAsync.
  for(const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']){
    if(typeof adapter[name]!=='function')continue;
    const original=adapter[name].bind(adapter);
    adapter[name]=data=>normalizeVersion(original({...(data||{}),adapterVersion:VERSION}));
  }

  async function ensureDiag(){
    const defs={
      'status.debug.visVersionOwner576':{name:'VIS Versionsbesitzer 0.5.76',type:'string'},
      'status.debug.visVersionLegacyBlocked576':{name:'Zuletzt blockierte alte VIS-Version 0.5.76',type:'string'},
      'status.debug.visVersionRewriteCount576':{name:'Anzahl blockierter VIS-Versionswrites 0.5.76',type:'number'},
      'status.debug.phoneTemp576':{name:'Phone Temperaturkurve 0.5.76',type:'string'},
      'status.debug.phoneTemp576HistoryCount':{name:'Phone Temperaturkurve History-Werte 0.5.76',type:'number'},
      'status.debug.phoneTemp576Source':{name:'Phone Temperaturkurve Quelle 0.5.76',type:'string'}
    };
    for(const [id,d] of Object.entries(defs))await adapter.setObjectNotExistsAsync(id,{type:'state',common:{name:d.name,type:d.type,role:d.type==='number'?'value':'text',read:true,write:false,def:d.type==='number'?0:''},native:{}});
  }
  async function publishDiag(){
    try{
      await ensureDiag();
      await rawSetStateAsync('status.debug.visVersionOwner576','0.5.76 · finaler setStateAsync-Guard · Version + Phone-Kurve in einer Schicht',true);
      await rawSetStateAsync('status.debug.visVersionLegacyBlocked576',lastLegacy||'noch keine Altversion abgefangen',true);
      await rawSetStateAsync('status.debug.visVersionRewriteCount576',rewriteCount,true);
      await rawSetStateAsync('status.debug.phoneTemp576',`${lastInsert}${cache.error?' · '+cache.error:''}`,true);
      await rawSetStateAsync('status.debug.phoneTemp576HistoryCount',cache.count||0,true);
      await rawSetStateAsync('status.debug.phoneTemp576Source',cache.source||'',true);
    }catch{}
  }

  adapter.on('ready',()=>{
    const h=adapter.trackTimeout(setTimeout(async()=>{
      try{adapter.pendingTimeouts.delete(h);}catch{}
      if(adapter.isShuttingDown)return;
      await loadCurve(true);
      try{
        adapter.lastRenderSignature='';adapter.lastRenderAt=0;
        if(typeof adapter.renderVisFull==='function')await adapter.renderVisFull(true);
      }catch{}
      await publishDiag();
      const timer=setInterval(async()=>{
        if(adapter.isShuttingDown)return;
        await loadCurve(true);
        await publishDiag();
      },60000);
      if(typeof adapter.trackInterval==='function')adapter.trackInterval(timer);
    },2400));
  });
  return adapter;
}

function createAdapter(options={}){return install(createBase(options));}
if(require.main!==module)module.exports=createAdapter;else createAdapter();

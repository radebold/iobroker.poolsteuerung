'use strict';

// 0.5.71: vorhandene 24h-Temperatur-SVG direkt in die obere Temperaturzeile kopieren.
// Der bisherige ps-temp-spark-Bereich bleibt unsichtbar mit gleicher Hoehe bestehen,
// damit sich die Gesamtgroesse der Phone-VIS nicht aendert.
const createBase = require('./main-ipadmini-final-570.js');
const VERSION = 'v0.5.71';
const PHONE_IDS = new Set(['vis.htmlPhone', 'vis.widgetPhone']);

function patchVersion(v){return String(v||'').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g,VERSION);}

function patchPhone(html){
  let out=patchVersion(html);
  if(!out) return out;
  out=out.replace(/<style data-phone-temp-571="1">[\s\S]*?<\/style>/g,'');
  out=out.replace(/<div class="ps-temp-inline-571">[\s\S]*?<\/div>/g,'');

  const m=out.match(/<div class="ps-temp-spark">([\s\S]*?<svg[\s\S]*?<\/svg>[\s\S]*?)<\/div>/i);
  if(!m) return out;
  const svgMatch=m[1].match(/<svg[\s\S]*?<\/svg>/i);
  if(!svgMatch) return out;
  const svg=svgMatch[0];

  const css='<style data-phone-temp-571="1">.ps-tempRow{min-width:0}.ps-temp-inline-571{position:relative;height:34px;flex:1 1 auto;min-width:90px;max-width:190px;margin-left:8px;margin-right:150px;color:#76d7ff;overflow:hidden;align-self:center}.ps-temp-inline-571 svg,.ps-temp-inline-571 .sparkline{display:block!important;width:100%!important;max-width:none!important;height:34px!important;overflow:hidden!important}.ps-temp-inline-571 path{stroke-width:1!important}.ps-temp-spark{visibility:hidden!important}</style>';
  if(out.includes('</head>')) out=out.replace('</head>',css+'</head>'); else out=css+out;
  out=out.replace(/(<div class="ps-tempRow">\s*<div class="ps-temp">[\s\S]*?<\/div>\s*<div class="ps-unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,`$1<div class="ps-temp-inline-571">${svg}</div>$2`);
  return out;
}

function install(adapter){
  if(!adapter||adapter.__phone571Installed)return adapter;
  adapter.__phone571Installed=true;
  const prev=typeof adapter.setStateIfChanged==='function'?adapter.setStateIfChanged.bind(adapter):null;
  adapter.setStateIfChanged=async function(id,value,ack=true,...rest){
    if(PHONE_IDS.has(String(id))&&typeof value==='string'){
      const next=patchPhone(value);
      const cur=await adapter.getStateAsync(id);
      if(cur&&cur.val===next)return false;
      await adapter.setStateAsync(id,next,ack);
      return true;
    }
    return prev?prev(id,value,ack,...rest):adapter.setStateAsync(id,value,ack);
  };
  async function patchExisting(){
    for(const id of PHONE_IDS){
      try{const s=await adapter.getStateAsync(id);const cur=String(s&&s.val||'');if(!cur)continue;const next=patchPhone(cur);if(next!==cur)await adapter.setStateAsync(id,next,true);}catch{}
    }
  }
  if(typeof adapter.renderVisFull==='function'){
    const orig=adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull=async function(...args){const r=await orig(...args);await patchExisting();return r;};
  }
  adapter.on('ready',()=>{const h=adapter.trackTimeout(setTimeout(async()=>{try{adapter.pendingTimeouts.delete(h);}catch{}if(adapter.isShuttingDown)return;await patchExisting();try{adapter.lastRenderSignature='';adapter.lastRenderAt=0;if(typeof adapter.renderVisFull==='function')await adapter.renderVisFull(true);}catch{}},1800));});
  return adapter;
}
function createAdapter(options={}){return install(createBase(options));}
if(require.main!==module)module.exports=createAdapter;else createAdapter();

'use strict';

// 0.5.66: gleiche sichtbare Anpassung wie 0.5.65, aber auf ALLEN VIS-States.
// Damit wird auch vis.htmlIpadMini erfasst, falls genau dieser State auf dem iPhone angezeigt wird.
const createBase = require('./main-ipadmini-final-565.js');
const VERSION = 'v0.5.66';
const VIS_IDS = ['vis.htmlTablet','vis.widgetTablet','vis.htmlPhone','vis.widgetPhone','vis.htmlIpadMini'];
const LOCAL24H_ID = 'status.trend.ipadMiniLocal24hJson';
const POOL24H_ID = 'status.trend.poolTemp24hJson';

function num(v){if(v===undefined||v===null||v==='')return null;const n=Number(String(v).trim().replace(',','.'));return Number.isFinite(n)?n:null;}
function parseJson(v,f){try{return JSON.parse(String(v||''));}catch{return f;}}
function patchVersion(v){return String(v||'').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g,VERSION);}
function normalizeRows(rows){const now=Date.now(),start=now-86400000;return(Array.isArray(rows)?rows:[]).map(r=>({ts:Number(r&&r.ts),val:num(r&&(r.val!==undefined?r.val:r))})).filter(r=>Number.isFinite(r.ts)&&r.val!==null&&r.ts>=start&&r.ts<=now).sort((a,b)=>a.ts-b.ts);}
function buildSvg(rows){let a=normalizeRows(rows);if(a.length<2)return'';if(a.length>96){const s=[];for(let i=0;i<96;i++)s.push(a[Math.round(i*(a.length-1)/95)]);a=s;}const ns=a.map(r=>r.val),lo=Math.min(...ns),hi=Math.max(...ns),rg=Math.max(.6,hi-lo),c=(lo+hi)/2,min=c-rg*.62,max=c+rg*.62,t0=a[0].ts,t1=a[a.length-1].ts,tr=Math.max(1,t1-t0),vr=Math.max(.001,max-min),W=160,H=30;const x=t=>2+((t-t0)/tr)*156,y=v=>3+(1-((v-min)/vr))*24,r=n=>Math.round(n*10)/10;const p=a.map((o,i)=>`${i?'L':'M'}${r(x(o.ts))} ${r(y(o.val))}`).join(' '),last=a[a.length-1];return`<svg class="phone-temp24-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${p}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${r(x(last.ts))}" cy="${r(y(last.val))}" r="1.6" fill="currentColor"/></svg>`;}

function inject(html,svg){
  let out=patchVersion(html);
  if(!out||!out.includes('Pool Manager')||!out.includes('PH-Info'))return out;
  out=out.replace(/<style data-visible-566="1">[\s\S]*?<\/style>/g,'').replace(/<script data-visible-566="1">[\s\S]*?<\/script>/g,'');
  const css=`<style data-visible-566="1">.phone-temp24-inline{height:30px;min-width:92px;max-width:150px;flex:1 1 120px;margin-left:10px;align-self:center;position:relative;overflow:hidden;color:#39aef7;pointer-events:none}.phone-temp24-inline .phone-temp24-svg{display:block;width:100%!important;height:30px!important}.phone-temp24-inline:after{content:'24h';position:absolute;right:1px;bottom:0;font-size:7px;line-height:1;color:#b6cce3;font-weight:700}</style>`;
  const safe=JSON.stringify(String(svg||''));
  const js=`<script data-visible-566="1">(function(){function run(){try{var root=document.querySelector('.hero,.ps-hero');if(!root)return;var all=[].slice.call(root.querySelectorAll('button,label,div,span')),n=all.find(function(e){return(e.textContent||'').replace(/\\s+/g,' ').trim()==='PH-Info'}),ph=n&&(n.closest('button,label')||n);if(ph){var hr=root.getBoundingClientRect(),pr=ph.getBoundingClientRect(),dx=(hr.right-14)-pr.right;if(Math.abs(dx)>1){ph.style.transform='translateX('+Math.round(dx)+'px)';ph.style.transformOrigin='center center'}}var row=root.querySelector('.temp-row,.ps-tempRow');if(row&&!row.querySelector('.phone-temp24-inline')){var s=${safe};if(s){var b=document.createElement('div');b.className='phone-temp24-inline';b.innerHTML=s;row.appendChild(b)}}}catch(e){}}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();setTimeout(run,250);setTimeout(run,1000)})();</script>`;
  if(out.includes('</head>'))out=out.replace('</head>',css+'</head>');else out=css+out;
  if(out.includes('</body>'))out=out.replace('</body>',js+'</body>');else out+=js;
  return out;
}

function install(adapter){
  if(!adapter||adapter.__visible566Installed)return adapter;
  adapter.__visible566Installed=true;
  let svg='';
  async function refreshSvg(){let rows=[];try{const s=await adapter.getStateAsync(LOCAL24H_ID),o=parseJson(s&&s.val,{});if(o&&Array.isArray(o.water))rows=o.water;}catch{}if(normalizeRows(rows).length<2){try{const s=await adapter.getStateAsync(POOL24H_ID),a=parseJson(s&&s.val,[]);if(Array.isArray(a))rows=a;}catch{}}try{const id=String((adapter.config&&adapter.config.waterTempStateId)||'').trim();if(id){const s=await adapter.getForeignStateAsync(id),v=num(s&&s.val);if(v!==null)rows=[...normalizeRows(rows),{ts:Date.now(),val:v}];}}catch{}svg=buildSvg(rows);}
  async function patchAll(){await refreshSvg();for(const id of VIS_IDS){try{const s=await adapter.getStateAsync(id),cur=String(s&&s.val||'');if(!cur)continue;const next=inject(cur,svg);if(next!==cur)await adapter.setStateAsync(id,next,true);}catch{}}}
  if(typeof adapter.renderVisFull==='function'){const original=adapter.renderVisFull.bind(adapter);adapter.renderVisFull=async function(...args){const r=await original(...args);await patchAll();return r;};}
  if(typeof adapter.forceImmediateRender==='function'){const original=adapter.forceImmediateRender.bind(adapter);adapter.forceImmediateRender=async function(...args){const r=await original(...args);await patchAll();return r;};}
  adapter.on('ready',()=>{const h=adapter.trackTimeout(setTimeout(async()=>{try{adapter.pendingTimeouts.delete(h);}catch{}if(!adapter.isShuttingDown)await patchAll();},1800));});
  return adapter;
}
function createAdapter(options={}){return install(createBase(options));}
if(require.main!==module)module.exports=createAdapter;else createAdapter();

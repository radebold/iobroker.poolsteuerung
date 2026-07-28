'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.39';
const STATE = 'vis.htmlIpadMini';
const LIMIT = 14000;

const n = v => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};
const f = (v, d = 1) => {
  const x = n(v);
  return x === null ? '--' : x.toFixed(d).replace('.', ',');
};
const b = v => typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : ['true','1','on','ein','ja','active','aktiv'].includes(String(v ?? '').toLowerCase());
const e = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function pts(list, current) {
  const now = Date.now(), start = now - 86400000;
  let a = (Array.isArray(list) ? list : []).map(r => ({ t:Number(r && r.ts), v:n(r && (r.val !== undefined ? r.val : r)) }))
    .filter(r => Number.isFinite(r.t) && r.v !== null && r.t >= start && r.t <= now).sort((x,y)=>x.t-y.t);
  const c = n(current);
  if (c !== null && (!a.length || now-a[a.length-1].t > 15000)) a.push({t:now,v:c});
  if (!a.length && c !== null) a=[{t:start,v:c},{t:now,v:c}];
  if (a.length === 1) a.unshift({t:a[0].t-3600000,v:a[0].v});
  if (a.length > 16) {
    const z=[]; for(let i=0;i<16;i++) z.push(a[Math.round(i*(a.length-1)/15)]); a=z;
  }
  return a;
}

function graph(list, current, color, digits, minRange, unit='') {
  const a=pts(list,current);
  if(a.length<2) return {s:'',lo:'--',hi:'--'};
  const vs=a.map(x=>x.v), lo=Math.min(...vs), hi=Math.max(...vs), range=Math.max(hi-lo,minRange), mid=(lo+hi)/2, min=mid-range*.62, max=mid+range*.62;
  const t0=a[0].t, tr=Math.max(1,a[a.length-1].t-t0), vr=Math.max(.0001,max-min);
  const p=x=>({x:Math.round((2+(x.t-t0)/tr*456)*10)/10,y:Math.round((6+(1-(x.v-min)/vr)*83)*10)/10});
  const d=a.map((x,i)=>{const q=p(x);return (i?'L':'M')+q.x+' '+q.y}).join(' '), q=p(a[a.length-1]);
  return {s:`<svg viewBox="0 0 460 95" preserveAspectRatio="none"><path class="g" d="M0 24H460M0 48H460M0 72H460"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2"/><circle cx="${q.x}" cy="${q.y}" r="3" fill="${color}"/></svg>`,lo:f(lo,digits)+unit,hi:f(hi,digits)+unit};
}

async function json(adapter,id,fb){
  try{const s=await adapter.getStateAsync(id);const x=JSON.parse(String((s&&s.val)||''));return x??fb}catch{return fb}
}
async function history(adapter){
  const l=await json(adapter,'status.trend.ipadMiniLocal24hJson',{});
  const [w,p,o]=await Promise.all([
    json(adapter,'status.trend.poolTemp24hJson',[]),
    json(adapter,'status.trend.phTodayJson',[]),
    json(adapter,'status.trend.orpTodayJson',[])
  ]);
  return {outside:Array.isArray(l.outside)?l.outside:[],water:Array.isArray(l.water)&&l.water.length?l.water:w,ph:Array.isArray(l.ph)&&l.ph.length?l.ph:p,orp:Array.isArray(l.orp)&&l.orp.length?l.orp:o};
}

function build(data,h,ns){
  const pump=b(data.pumpOn), php=b(data.phPumpOn), chlor=b(data.chlorOn), hp=b(data.heatpumpOn);
  const heating=hp&&/(heiz|heat|warm)/i.test(String(data.heatpumpMode??'')), fan=n(data.heatpumpFanPercent);
  const pc=data.phCanister||{}, lev=n(pc.levelL), pct=n(pc.percent), kg=n(pc.netKg!==undefined?pc.netKg:pc.weightKg);
  const can=lev===null?'pH-Minus --':`pH-Minus ${pc.scaleEnabled===true?'≈ ':''}${f(lev,2)} l${kg!==null?' · '+f(kg,3)+' kg':''}${pct!==null?' · '+f(pct,0)+' %':''}`;
  const cards=[
    ['outside','Außentemperatur',data.outsideTemp,1,'°C','#58baff',data.outsideTempTrend,1,'☀'],
    ['water','Wassertemperatur',data.poolTemp,1,'°C','#60ddd9',data.poolTempTrend,1,'◉'],
    ['ph','pH-Wert',data.ph,2,'',data.phInRange?'#67df7e':'#ffbd59',data.phTrend,.1,'⚗'],
    ['orp','ORP-Wert',data.orp,0,'mV',data.orpInRange?'#67df7e':'#ff9f59',data.orpTrend,30,'ϟ']
  ];
  const html=cards.map(c=>{
    const [k,l,v,d,u,col,tr,r,ic]=c, gr=graph(h[k]||[],v,col,d,r,u?' '+u:'');
    let x='';
    if(k==='ph') x=`<div class="can">${e(can)}</div><div class="st ${php?'on':''}"><i></i>Dosierpumpe ${php?'EIN':'AUS'}</div><div class="ctl"><button data-d="60">60 s</button><button data-d="120">120 s</button><button data-d="180">180 s</button><input id="pl" inputmode="decimal" placeholder="PoolLab 7,18"><button id="sv">Speichern</button></div>`;
    if(k==='orp') x=`<div class="st ${chlor?'on':''}"><i></i>Chlorinator ${chlor?'EIN':'AUS'}</div>`;
    return `<section class="c ${k}" style="--a:${col}"><header><span>${ic}</span><b>${l}</b>${k==='ph'?'':'<small>24 Stunden</small>'}</header>${x}<div class="v"><strong>${f(v,d)}</strong>${u?`<em>${u}</em>`:''}<q>${e(tr||'→')}</q></div><div class="gr">${gr.s}</div><div class="mm"><span>Min ${e(gr.lo)}</span><span>Max ${e(gr.hi)}</span></div></section>`;
  }).join('');
  const sc=String(data.nextActionsText||'--').split(/\n+/).map(x=>x.trim()).filter(Boolean).slice(0,3).map(x=>`<span>${e(x)}</span>`).join('')||'<i>Keine kommenden Schaltungen</i>';
  const N=JSON.stringify(String(ns||'poolsteuerung.0'));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#06111e;color:#f6fbff;font-family:Arial,sans-serif}.s{height:100vh;padding:8px 10px;display:grid;grid-template-rows:36px 1fr 38px 38px;gap:7px;background:linear-gradient(145deg,#06101c,#0a1a2c)}.top{display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:8px}.logo{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:#2199bd}.ttl{font-size:21px;font-weight:900}.sub,.meta{font-size:9px;color:#9bb0c8}.meta{text-align:right}.pump,.st{display:flex;align-items:center;gap:5px;border:1px solid #2a3c50;border-radius:20px;background:#071827;font-size:8px;font-weight:900}.pump{padding:4px 8px;margin-left:8px}.pump i,.st i{width:10px;height:10px;border-radius:50%}.pump i{background:#ff625b}.st i{background:#7c8da0}.pump.on i,.st.on i{background:#63e07b;box-shadow:0 0 8px #63e07b}.cards{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:7px;min-height:0}.c{position:relative;overflow:hidden;border:1px solid #26384a;border-radius:15px;padding:10px 13px 7px;background:#0d2035}.c:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--a)}.c header{height:27px;display:grid;grid-template-columns:26px 1fr auto;align-items:center;gap:7px}.c header>span{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;border:1px solid #2b4054;color:var(--a)}.c header b{font-size:16px}.c header small{font-size:8px;color:#9bb0c8}.v{height:78px;display:flex;align-items:center;justify-content:center;gap:7px}.v strong{font-size:70px;line-height:.9;color:var(--a);letter-spacing:-3px}.v em{font-style:normal;font-size:24px;font-weight:900}.v q{font-size:28px;text-decoration:none;color:#afbed0}.gr{height:88px;background:#081827;border-radius:9px;overflow:hidden}.gr svg{width:100%;height:100%}.g{fill:none;stroke:#26384a}.mm{height:18px;display:flex;justify-content:space-between;align-items:end;color:#9bb0c8;font-size:9px}.can{position:absolute;right:13px;top:10px;max-width:205px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 7px;border:1px solid #34485b;border-radius:8px;background:#071827;color:#78e68d;font-size:8px;font-weight:900}.st{position:absolute;right:13px;top:105px;padding:4px 7px;color:#aab9c8}.c.ph .st{top:43px}.ctl{position:absolute;left:13px;right:13px;top:102px;z-index:4;display:flex;gap:4px;align-items:center}.ctl button{height:24px;border:1px solid #397baa;border-radius:20px;background:#195786;color:white;font-size:8px;font-weight:900;padding:2px 7px}.ctl input{margin-left:auto;width:105px;height:24px;border:1px solid #397baa;border-radius:20px;background:#061522;color:white;padding:2px 8px;font-size:9px}.ctl #sv{background:#17685c;border-color:#2a927f}.bar{border:1px solid #26384a;border-radius:12px;background:#0a1c2f;display:grid;align-items:center;padding:5px 9px}.hp{grid-template-columns:1.3fr repeat(3,1fr)}.hp div{display:flex;justify-content:space-between;padding:0 8px;border-left:1px solid #26384a;font-size:9px;color:#9bb0c8}.hp div:first-child{border:0;color:white;font-size:11px;font-weight:900}.hp b.on{color:#67df7e}.sch{grid-template-columns:auto 1fr;gap:8px}.sch>b{font-size:9px;color:#9bb0c8}.sch div{display:flex;justify-content:flex-end;gap:5px;overflow:hidden}.sch span{max-width:31%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid #27506d;border-radius:20px;padding:4px 7px;font-size:8px}.sch i{font-size:9px;color:#9bb0c8}@media(max-width:900px){.v strong{font-size:62px}.gr{height:80px}.ctl{top:96px}.st{top:99px}.c.ph .st{top:41px}}</style></head><body><main class="s"><div class="top"><div class="brand"><span class="logo">◉</span><div><div><span class="ttl">POOL</span><span class="pump ${pump?'on':''}"><i></i>Umwälzpumpe ${pump?'EIN':'AUS'}</span></div><div class="sub">24H LIVE-VERLAUF</div></div></div><div class="meta">${e(data.updated||'--')}<br>${VERSION} · iPad Mini</div></div><div class="cards">${html}</div><div class="bar hp"><div>↻ Wärmepumpe</div><div>LÄUFT <b class="${hp?'on':''}">${hp?'JA':'NEIN'}</b></div><div>HEIZT <b class="${heating?'on':''}">${heating?'JA':'NEIN'}</b></div><div>DREHZAHL <b>${fan===null?'--':Math.round(fan)+' %'}</b></div></div><div class="bar sch"><b>NÄCHSTE SCHALTUNGEN</b><div>${sc}</div></div></main><script>(function(){var n=${N};function a(){for(var w of [window,window.parent,window.top])try{if(w.vis)return w.vis}catch(e){}return null}async function s(i,v){var x=a();if(!x)return false;try{if(x.setValue){var r=x.setValue(i,v);if(r&&r.then)await r;return true}}catch(e){}try{if(x.conn&&x.conn.setState){var q=x.conn.setState(i,v);if(q&&q.then)await q;return true}}catch(e){}return false}document.onclick=async function(e){var d=e.target.closest&&e.target.closest('[data-d]');if(d){var t=d.textContent;d.textContent='…';d.disabled=true;var ok=await s(n+'.control.ph.manualDoseSec',+d.dataset.d);if(ok)ok=await s(n+'.control.ph.manualTrigger',Date.now());d.textContent=ok?'OK':'Fehler';setTimeout(()=>{d.textContent=t;d.disabled=false},1200);return}if(e.target.id==='sv'){var i=document.getElementById('pl'),v=Number(String(i.value).replace(',','.')),t=e.target.textContent;if(!Number.isFinite(v)||v<0||v>14){e.target.textContent='Ungültig';setTimeout(()=>e.target.textContent=t,1200);return}e.target.disabled=true;e.target.textContent='…';var ok=await s(n+'.control.ph.calibration.poollabValue',v);if(ok)ok=await s(n+'.control.ph.calibration.saveTrigger',Date.now());e.target.textContent=ok?'Gespeichert':'Fehler';if(ok)i.value='';setTimeout(()=>{e.target.textContent=t;e.target.disabled=false},1400)}}})();</script></body></html>`;
}

function valid(x){return x.startsWith('<!doctype html>')&&x.endsWith('</html>')&&x.includes('id="pl"')&&x.includes('data-d="60"')&&Buffer.byteLength(x,'utf8')<=LIMIT}

function install(adapter){
  if(!adapter||adapter.__ipadMiniCompactInstalled)return adapter;
  adapter.__ipadMiniCompactInstalled=true;
  const original=adapter.buildTabletHtml.bind(adapter);
  adapter.buildTabletHtml=data=>{
    adapter.__ipadMiniCompactData={...(data||{})};
    return String(original({...(data||{}),adapterVersion:VERSION})).replace(/v0\.4\.\d+/g,VERSION);
  };
  const base=adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull=async(...args)=>{
    const result=await base(...args);
    const data=adapter.__ipadMiniCompactData;
    if(!data)return result;
    try{
      const x=build(data,await history(adapter),adapter.namespace);
      if(!valid(x)){adapter.log.warn(`[IPAD-MINI] Kompaktansicht verworfen: ${Buffer.byteLength(x,'utf8')} Bytes`);return result}
      await adapter.setStateIfChanged(STATE,x,true);
      if(!adapter.__ipadMiniCompactLogged){adapter.__ipadMiniCompactLogged=true;adapter.log.info(`[IPAD-MINI] ${VERSION}: vollständige Kompaktansicht aktiv (${Buffer.byteLength(x,'utf8')} Bytes)`) }
    }catch(err){adapter.log.warn('[IPAD-MINI] Kompaktansicht fehlgeschlagen: '+(err.message||err))}
    return result;
  };
  adapter.on('ready',()=>{
    for(const ms of [1000,4000]){
      const h=adapter.trackTimeout(setTimeout(async()=>{
        adapter.pendingTimeouts.delete(h);
        if(adapter.isShuttingDown)return;
        try{adapter.lastRenderSignature='';adapter.lastRenderAt=0;await adapter.forceImmediateRender()}catch(err){if(!adapter.isDbClosedError(err))adapter.log.warn('[IPAD-MINI] Wiederherstellung fehlgeschlagen: '+(err.message||err))}
      },ms));
    }
  });
  return adapter;
}

function createAdapter(options={}){return install(createBase(options))}
if(require.main!==module)module.exports=createAdapter;else createAdapter();

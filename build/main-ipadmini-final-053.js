'use strict';

// Controls only the user's pH-canister scale via its existing ioBroker MQTT command states.
const createBase = require('./main-ipadmini-final-052.js');
const VERSION = 'v0.4.53';
const IPAD_STATE = 'vis.htmlIpadMini';
const VIS_STATES = ['vis.htmlTablet','vis.widgetTablet','vis.htmlPhone','vis.widgetPhone',IPAD_STATE];

function escAttr(v){return String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function version(v){return String(v||'').replace(/v0\.4\.\d+/g,VERSION);}

function commandHandler(){
  return escAttr([
    "var b=event.target&&event.target.closest?event.target.closest('button[data-scale-state]'):null",
    "if(!b||b.disabled)return false",
    "event.preventDefault();event.stopPropagation()",
    "var id=b.dataset.scaleState,old=b.textContent",
    "var v=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    "if(!v){b.textContent='Fehler';setTimeout(function(){b.textContent=old},1200);return false}",
    "b.disabled=true;b.textContent='…'",
    "function w(x){if(typeof v.setValue==='function')return Promise.resolve(v.setValue(id,x));if(v.conn&&typeof v.conn.setState==='function')return Promise.resolve(v.conn.setState(id,x));return Promise.reject(new Error('setState nicht verfügbar'))}",
    "w(true).then(function(){b.classList.add('ok');b.textContent='OK';setTimeout(function(){w(false)},700);setTimeout(function(){b.classList.remove('ok');b.textContent=old;b.disabled=false},1500)},function(){b.classList.add('error');b.textContent='Fehler';setTimeout(function(){b.classList.remove('error');b.textContent=old;b.disabled=false},1600)})",
    "return false"
  ].join(';'));
}

const CSS=`
.scale-controls{display:inline-flex;align-items:center;gap:4px;margin-left:2px}
.scale-controls button{height:24px;min-width:43px;padding:0 7px;border:1px solid rgba(255,255,255,.13);border-radius:8px;background:linear-gradient(180deg,#274a79,#142a48);color:#eaf5ff;font:700 8px/1 "Segoe UI Variable","Segoe UI",Arial,sans-serif;cursor:pointer}
.scale-controls button[data-scale-state$="restart"]{min-width:49px;background:linear-gradient(180deg,#74482a,#432818);color:#ffd9bf}
.scale-controls button:disabled{opacity:.72}.scale-controls button.ok{background:linear-gradient(180deg,#258353,#155334);color:#c9f8d6}.scale-controls button.error{background:linear-gradient(180deg,#a74643,#6c2927);color:#ffe0dc}
@media(max-width:900px){.scale-controls{gap:3px}.scale-controls button{height:22px;min-width:39px;padding:0 5px;font-size:7px}.scale-controls button[data-scale-state$="restart"]{min-width:45px}}
`;

function patchIpad(v){
  let html=version(v);
  if(!html||!html.includes('class="ipad-final"')||html.includes('data-scale-controls="1"'))return html;
  const h=commandHandler();
  const controls=`<span class="scale-controls" data-scale-controls="1" onclick="${h}"><button type="button" data-scale-state="mqtt.0.pool.phminus.waage.cmd.tare" title="Waage tarieren">Tara</button><button type="button" data-scale-state="mqtt.0.pool.phminus.waage.cmd.restart" title="Waage neu starten">Reboot</button></span>`;
  const pump=/(<span class="pump [^"]*"><i><\/i>Umwälzpumpe (?:EIN|AUS)<\/span>)/;
  if(!pump.test(html))return html;
  return html.replace(pump,`$1${controls}`).replace('</style>',`${CSS}</style>`);
}

async function patchStates(adapter){
  for(const id of VIS_STATES){
    try{
      const st=await adapter.getStateAsync(id);
      const cur=String((st&&st.val)||'');
      const next=id===IPAD_STATE?patchIpad(cur):version(cur);
      if(next&&next!==cur)await adapter.setStateIfChanged(id,next,true);
    }catch(e){}
  }
}

function install(adapter){
  if(!adapter||adapter.__ipadScaleControls053Installed)return adapter;
  adapter.__ipadScaleControls053Installed=true;
  for(const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']){
    if(typeof adapter[name]!=='function')continue;
    const original=adapter[name].bind(adapter);
    adapter[name]=data=>version(original({...data,adapterVersion:VERSION}));
  }
  if(typeof adapter.renderVisFull==='function'){
    const render=adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull=async(...args)=>{const result=await render(...args);await patchStates(adapter);return result;};
  }
  adapter.on('ready',()=>{
    const handle=adapter.trackTimeout(setTimeout(async()=>{
      adapter.pendingTimeouts.delete(handle);
      if(adapter.isShuttingDown)return;
      adapter.lastRenderSignature='';adapter.lastRenderAt=0;
      try{await adapter.forceImmediateRender();}catch(e){}
    },2200));
  });
  return adapter;
}

function createAdapter(options={}){return install(createBase(options));}
if(require.main!==module)module.exports=createAdapter;else createAdapter();

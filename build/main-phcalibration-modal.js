'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.13';

function modalCss() {
  return `<style data-ph-cal-modal-style="1">
.ph-cal-trigger{cursor:pointer!important;position:relative;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.ph-cal-trigger:after{content:"PoolLab";display:inline-flex;align-items:center;margin-left:8px;padding:3px 7px;border-radius:999px;border:1px solid rgba(85,200,255,.28);background:rgba(85,200,255,.11);color:#8edfff;font-size:8px;font-weight:900;letter-spacing:.04em;vertical-align:middle}
.ph-cal-trigger:active{transform:scale(.985)}
.ph-cal-overlay{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(2,8,16,.76);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.ph-cal-overlay.is-open{display:flex}
.ph-cal-dialog{width:min(410px,calc(100vw - 30px));border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:17px;background:linear-gradient(150deg,#122a43,#071522);box-shadow:0 28px 70px rgba(0,0,0,.55);color:#f4fbff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
.ph-cal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:15px}.ph-cal-title{font-size:20px;font-weight:900}.ph-cal-sub{margin-top:3px;color:#9eb2c9;font-size:11px}.ph-cal-close{width:34px;height:34px;border:1px solid rgba(255,255,255,.10);border-radius:11px;background:rgba(255,255,255,.06);color:#dbe9f7;font-size:21px;line-height:1;cursor:pointer}
.ph-cal-current{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px;padding:10px 12px;border:1px solid rgba(85,200,255,.14);border-radius:12px;background:rgba(85,200,255,.07)}.ph-cal-current-label{color:#9eb2c9;font-size:10px;font-weight:850;text-transform:uppercase;letter-spacing:.05em}.ph-cal-current-value{color:#67df7e;font-size:22px;font-weight:900}
.ph-cal-input-wrap{position:relative}.ph-cal-input-label{display:block;margin:0 0 6px;color:#c9d8e7;font-size:11px;font-weight:850}.ph-cal-input{width:100%;height:62px;border:1px solid rgba(85,200,255,.38);border-radius:14px;background:rgba(2,12,22,.58);color:#fff;padding:7px 55px 7px 14px;font-size:30px;font-weight:900;outline:none;font-variant-numeric:tabular-nums}.ph-cal-input:focus{border-color:#55c8ff;box-shadow:0 0 0 3px rgba(85,200,255,.14)}.ph-cal-unit{position:absolute;right:15px;bottom:19px;color:#9eb2c9;font-size:12px;font-weight:850}
.ph-cal-message{min-height:18px;margin:8px 2px 10px;color:#9eb2c9;font-size:10px;font-weight:750}.ph-cal-message.ok{color:#86efa0}.ph-cal-message.error{color:#ffaaa1}
.ph-cal-actions{display:grid;grid-template-columns:1fr 1.6fr;gap:9px}.ph-cal-btn{height:46px;border-radius:12px;font-family:inherit;font-size:12px;font-weight:900;cursor:pointer}.ph-cal-cancel{border:1px solid rgba(255,255,255,.11);background:rgba(255,255,255,.06);color:#dbe8f5}.ph-cal-save{border:0;background:linear-gradient(145deg,#278ed7,#24bdb4);color:#fff;box-shadow:0 8px 22px rgba(39,142,215,.22)}.ph-cal-save:disabled{opacity:.55;cursor:default}
@media(max-width:600px){.ph-cal-dialog{padding:15px}.ph-cal-title{font-size:18px}.ph-cal-input{font-size:28px}}
</style>`;
}

function modalHtml(namespace) {
  return `<div id="phCalOverlay" class="ph-cal-overlay" aria-hidden="true">
  <section class="ph-cal-dialog" role="dialog" aria-modal="true" aria-labelledby="phCalTitle">
    <div class="ph-cal-head">
      <div><div id="phCalTitle" class="ph-cal-title">PoolLab pH-Wert erfassen</div><div class="ph-cal-sub">Der aktuelle PH803-Rohwert wird automatisch übernommen.</div></div>
      <button id="phCalClose" class="ph-cal-close" type="button" aria-label="Schließen">×</button>
    </div>
    <div class="ph-cal-current"><span class="ph-cal-current-label">Aktuelle Anzeige</span><strong id="phCalCurrent" class="ph-cal-current-value">--</strong></div>
    <div class="ph-cal-input-wrap">
      <label class="ph-cal-input-label" for="phCalInput">PoolLab-Messwert</label>
      <input id="phCalInput" class="ph-cal-input" type="number" min="0" max="14" step="0.01" inputmode="decimal" placeholder="7,23" autocomplete="off">
      <span class="ph-cal-unit">pH</span>
    </div>
    <div id="phCalMessage" class="ph-cal-message">PoolLab-Wert eingeben und speichern.</div>
    <div class="ph-cal-actions"><button id="phCalCancel" class="ph-cal-btn ph-cal-cancel" type="button">Abbrechen</button><button id="phCalSave" class="ph-cal-btn ph-cal-save" type="button">Messwert speichern</button></div>
  </section>
</div>
<script data-ph-cal-modal-script="1">
(function(){
  var ns=${JSON.stringify(namespace)};
  var overlay=document.getElementById('phCalOverlay');
  var input=document.getElementById('phCalInput');
  var current=document.getElementById('phCalCurrent');
  var message=document.getElementById('phCalMessage');
  var save=document.getElementById('phCalSave');
  if(!overlay||!input||!save)return;

  function getVis(){
    try{if(window.vis)return window.vis}catch(e){}
    try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}
    try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}
    return null;
  }
  function getConn(){try{var v=getVis();if(v&&v.conn&&typeof v.conn.setState==='function')return v.conn}catch(e){}return null}
  async function setState(id,val){
    try{if(typeof window.poolSetState==='function')return await window.poolSetState(id,val)}catch(e){}
    var v=getVis(),c=getConn();
    try{if(v&&typeof v.setValue==='function'){var r=v.setValue(id,val);if(r&&typeof r.then==='function')await r;return true}}catch(e){}
    if(!c)return false;
    var attempts=[function(){return c.setState(id,val)},function(){return c.setState(id,val,false)},function(){return c.setState(id,val,function(){})},function(){return c.setState(id,val,false,function(){})}];
    for(var i=0;i<attempts.length;i++){try{var x=attempts[i]();if(x&&typeof x.then==='function')await x;return true}catch(e){}}
    return false;
  }
  function cleanText(value){return String(value||'').replace(/\s+/g,' ').trim()}
  function closeDialog(){overlay.classList.remove('is-open');overlay.setAttribute('aria-hidden','true');input.blur()}
  function openDialog(displayValue){
    current.textContent=cleanText(displayValue)||'--';
    input.value='';
    message.textContent='PoolLab-Wert eingeben und speichern.';
    message.className='ph-cal-message';
    save.disabled=false;
    save.textContent='Messwert speichern';
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden','false');
    setTimeout(function(){try{input.focus();input.select()}catch(e){}},80);
  }
  function findValueFromLabel(label){
    var node=label;
    for(var depth=0;node&&depth<7;depth++,node=node.parentElement){
      var value=node.querySelector&&node.querySelector('.metric-value,.metric-main,.ps-mmain,.ps-metric-value,.number');
      if(value)return value;
    }
    return null;
  }
  function bindTriggers(){
    var labels=document.querySelectorAll('.metric-label,.ps-label,.ps-k,.ps-metric-label,.metric-head span,.metric-head div');
    Array.prototype.forEach.call(labels,function(label){
      var text=cleanText(label.textContent).toLowerCase();
      if(text!=='ph'&&text!=='ph-wert'&&text!=='ph wert')return;
      var value=findValueFromLabel(label);
      if(!value||value.dataset.phCalBound==='1')return;
      value.dataset.phCalBound='1';
      value.classList.add('ph-cal-trigger');
      value.setAttribute('title','PoolLab-Messwert erfassen');
      var run=function(ev){try{ev.preventDefault();ev.stopPropagation()}catch(e){}openDialog(value.textContent);return false};
      value.addEventListener('click',run,false);
      label.style.cursor='pointer';
      label.addEventListener('click',run,false);
    });
  }
  async function saveValue(){
    var value=Number(String(input.value||'').replace(',','.'));
    if(!Number.isFinite(value)||value<0||value>14){message.textContent='Bitte einen gültigen PoolLab-pH-Wert eingeben.';message.className='ph-cal-message error';return}
    save.disabled=true;save.textContent='Speichere …';message.textContent='Messwert wird gespeichert …';message.className='ph-cal-message';
    var ok1=await setState(ns+'.control.ph.calibration.poollabValue',value);
    var ok2=ok1?await setState(ns+'.control.ph.calibration.saveTrigger',Date.now()):false;
    if(ok1&&ok2){message.textContent='Kalibrierpunkt gespeichert.';message.className='ph-cal-message ok';save.textContent='Gespeichert';setTimeout(closeDialog,650)}
    else{message.textContent='Speichern nicht möglich: VIS setState ist nicht verfügbar.';message.className='ph-cal-message error';save.disabled=false;save.textContent='Messwert speichern'}
  }
  document.getElementById('phCalClose').addEventListener('click',closeDialog);
  document.getElementById('phCalCancel').addEventListener('click',closeDialog);
  overlay.addEventListener('click',function(ev){if(ev.target===overlay)closeDialog()});
  input.addEventListener('keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();saveValue()}else if(ev.key==='Escape')closeDialog()});
  save.addEventListener('click',saveValue);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindTriggers);else bindTriggers();
  setTimeout(bindTriggers,500);
})();
</script>`;
}

function injectModal(html, namespace) {
  let value = String(html || '');
  if (!value || value.includes('data-ph-cal-modal-script="1"')) return value.replace(/v0\.4\.(?:5|6|7|8|9|10|11|12)/g, VERSION);
  const css = modalCss();
  const modal = modalHtml(namespace);
  value = value.replace(/v0\.4\.(?:5|6|7|8|9|10|11|12)/g, VERSION);
  value = value.includes('</head>') ? value.replace('</head>', `${css}</head>`) : `${css}${value}`;
  value = value.includes('</body>') ? value.replace('</body>', `${modal}</body>`) : `${value}${modal}`;
  return value;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationModalInstalled) return adapter;
  adapter.__phCalibrationModalInstalled = true;

  for (const methodName of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function buildWithPhCalibrationModal(data) {
      const html = original({ ...(data || {}), adapterVersion: VERSION });
      return injectModal(html, (data && data.namespace) || adapter.namespace);
    };
  }

  for (const methodName of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchVersionOnly(data) {
      return String(original({ ...(data || {}), adapterVersion: VERSION }))
        .replace(/v0\.4\.(?:5|6|7|8|9|10|11|12)/g, VERSION);
    };
  }

  try { adapter.log.info('[PH-KAL] v0.4.13: PoolLab-Dialog per Klick auf pH-Wert in Tablet/PC aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.14';

function clickScript(namespace) {
  return `<script data-ph-cal-click="1">
(function(){
  var ns=${JSON.stringify(namespace)};

  function clean(value){return String(value||'').replace(/\s+/g,' ').trim();}

  function getVis(){
    try{if(window.vis)return window.vis;}catch(e){}
    try{if(window.parent&&window.parent.vis)return window.parent.vis;}catch(e){}
    try{if(window.top&&window.top.vis)return window.top.vis;}catch(e){}
    return null;
  }

  function getConn(){
    try{var v=getVis();if(v&&v.conn&&typeof v.conn.setState==='function')return v.conn;}catch(e){}
    return null;
  }

  async function setState(id,val){
    try{if(typeof window.poolSetState==='function')return await window.poolSetState(id,val);}catch(e){}
    var v=getVis(),c=getConn();
    try{if(v&&typeof v.setValue==='function'){var r=v.setValue(id,val);if(r&&typeof r.then==='function')await r;return true;}}catch(e){}
    if(!c)return false;
    var attempts=[
      function(){return c.setState(id,val);},
      function(){return c.setState(id,val,false);},
      function(){return c.setState(id,val,function(){});},
      function(){return c.setState(id,val,false,function(){});}
    ];
    for(var i=0;i<attempts.length;i++){
      try{var x=attempts[i]();if(x&&typeof x.then==='function')await x;return true;}catch(e){}
    }
    return false;
  }

  function locatePhValue(label){
    var card=label.closest ? label.closest('.metric,.ps-metric') : null;
    if(!card)return null;
    return card.querySelector('.metric-main,.ps-mmain,.metric-value,.ps-v');
  }

  async function capturePoollab(displayValue, target){
    var entered=window.prompt('PoolLab pH-Wert eingeben\nAktuelle Anzeige: '+(clean(displayValue)||'--'),'');
    if(entered===null)return;
    var value=Number(String(entered).replace(',','.'));
    if(!Number.isFinite(value)||value<0||value>14){window.alert('Bitte einen gültigen PoolLab-pH-Wert eingeben.');return;}
    var ok1=await setState(ns+'.control.ph.calibration.poollabValue',value);
    var ok2=ok1?await setState(ns+'.control.ph.calibration.saveTrigger',Date.now()):false;
    if(!ok1||!ok2){window.alert('Speichern nicht möglich: VIS setState ist nicht verfügbar.');return;}
    if(target){
      var oldOutline=target.style.outline||'';
      target.style.outline='2px solid #67df7e';
      target.style.outlineOffset='3px';
      setTimeout(function(){target.style.outline=oldOutline;target.style.outlineOffset='';},900);
    }
  }

  function bind(){
    var labels=document.querySelectorAll('.metric-label,.ps-k');
    Array.prototype.forEach.call(labels,function(label){
      var text=clean(label.textContent).toLowerCase();
      if(text!=='ph'&&text!=='ph-wert'&&text!=='ph wert')return;
      var value=locatePhValue(label);
      if(!value||value.dataset.phCalBound==='1')return;
      value.dataset.phCalBound='1';
      value.style.cursor='pointer';
      value.style.touchAction='manipulation';
      value.title='PoolLab-Messwert erfassen';
      label.style.cursor='pointer';
      var run=function(ev){try{ev.preventDefault();ev.stopPropagation();}catch(e){}capturePoollab(value.textContent,value);return false;};
      value.addEventListener('click',run,false);
      label.addEventListener('click',run,false);
    });
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
  setTimeout(bind,400);
})();
</script>`;
}

function injectClickHandler(html, namespace) {
  let value = String(html || '');
  value = value.replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13)/g, VERSION);
  if (!value || value.includes('data-ph-cal-click="1"')) return value;
  const script = clickScript(namespace);
  return value.includes('</body>') ? value.replace('</body>', `${script}</body>`) : `${value}${script}`;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationClickInstalled) return adapter;
  adapter.__phCalibrationClickInstalled = true;

  for (const methodName of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function buildWithPhCalibrationClick(data) {
      const html = original({ ...(data || {}), adapterVersion: VERSION });
      return injectClickHandler(html, (data && data.namespace) || adapter.namespace);
    };
  }

  for (const methodName of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchVersionOnly(data) {
      return String(original({ ...(data || {}), adapterVersion: VERSION }))
        .replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13)/g, VERSION);
    };
  }

  try { adapter.log.info('[PH-KAL] v0.4.14: schlanke PoolLab-Eingabe per Klick auf pH aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

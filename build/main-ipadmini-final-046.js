'use strict';

const createBase = require('./main-ipadmini-final.js');

const VERSION = 'v0.4.46';
const STATE_ID = 'vis.htmlIpadMini';

function jsSingle(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function buildInlineHandler(namespace) {
  const ns = jsSingle(namespace);
  const code = `(async function(box,ev){
var b=ev&&ev.target&&ev.target.closest?ev.target.closest('button[data-dose]'):null;
if(!b||b.disabled)return;
ev.preventDefault();ev.stopPropagation();
var old=b.innerHTML,sec=Math.max(1,Number(b.dataset.dose)||30);
b.disabled=true;b.classList.add('working');b.innerHTML='<b>…</b><small>wird gestartet</small>';
function api(){try{if(window.vis)return window.vis}catch(e){}try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}return null}
async function setState(id,val){
var v=api(),c=null;
try{if(v&&typeof v.setValue==='function'){var r=v.setValue(id,val);if(r&&typeof r.then==='function')await r;return true}}catch(e){}
try{if(v&&v.conn&&typeof v.conn.setState==='function')c=v.conn}catch(e){}
if(!c)return false;
var a=[function(){return c.setState(id,val)},function(){return c.setState(id,val,false)},function(){return c.setState(id,val,function(){})},function(){return c.setState(id,val,false,function(){})}];
for(var i=0;i<a.length;i++){try{var x=a[i]();if(x&&typeof x.then==='function')await x;return true}catch(e){}}
return false}
var ok1=await setState('${ns}.control.ph.manualDoseSec',sec);
var ok2=ok1?await setState('${ns}.control.ph.manualTrigger',Date.now()):false;
b.classList.remove('working');b.classList.add(ok1&&ok2?'success':'error');
b.innerHTML=ok1&&ok2?'<b>Gestartet</b><small>'+sec+' Sekunden</small>':'<b>Fehler</b><small>nicht ausgelöst</small>';
if(!(ok1&&ok2)){try{alert('VIS setState nicht verfügbar')}catch(e){}}
setTimeout(function(){b.classList.remove('success','error');b.innerHTML=old;b.disabled=false},1800)
})(this,event);return false;`;
  return code.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function patchHtml(html, namespace) {
  let value = String(html || '');
  if (!value || !value.includes('data-ipad-final="1"')) return value;

  value = value.replace(/v0\.4\.\d+/g, VERSION);

  value = value
    .replace('font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif', 'font-family:"Segoe UI Variable","Segoe UI",-apple-system,BlinkMacSystemFont,Arial,sans-serif')
    .replace('.brand-title{display:flex;align-items:center;gap:10px;font-size:21px;font-weight:900;', '.brand-title{display:flex;align-items:center;gap:10px;font-size:21px;font-weight:750;')
    .replace('.metric-label{font-size:17px;font-weight:850}', '.metric-label{font-size:17px;font-weight:700;letter-spacing:-.01em}')
    .replace('.metric-value{font-size:73px;font-weight:900;', '.metric-value{font-size:70px;font-weight:760;')
    .replace('.metric-unit{font-size:25px;font-weight:850;', '.metric-unit{font-size:24px;font-weight:650;')
    .replace('.metric-trend{font-size:29px;font-weight:900;', '.metric-trend{font-size:27px;font-weight:650;')
    .replace('.dose-buttons button{width:62px;height:28px;padding:2px 4px;border:1px solid rgba(255,255,255,.12);border-radius:9px;background:linear-gradient(180deg,#2d4f86,#162d52);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer}', '.dose-buttons button{width:76px;height:34px;padding:3px 7px;border:1px solid rgba(130,188,255,.28);border-radius:12px;background:linear-gradient(180deg,#315f9d 0%,#193b6c 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 5px 12px rgba(0,0,0,.22);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;font-family:inherit;transition:transform .12s ease,filter .12s ease,background .12s ease}')
    .replace('.dose-buttons b{font-size:9px;line-height:10px}', '.dose-buttons b{font-size:11px;line-height:12px;font-weight:700}')
    .replace('.dose-buttons small{font-size:6px;line-height:7px;color:#dbeafe}', '.dose-buttons small{font-size:7px;line-height:9px;color:#cfe5ff;font-weight:500}')
    .replace('.dose-buttons button:disabled{opacity:.6}', '.dose-buttons button:hover{filter:brightness(1.08)}.dose-buttons button:active{transform:translateY(1px)}.dose-buttons button:disabled{opacity:.75;cursor:default}.dose-buttons button.working{background:linear-gradient(180deg,#3d5d83,#273d59)}.dose-buttons button.success{background:linear-gradient(180deg,#269258,#17643d);border-color:rgba(105,238,153,.38)}.dose-buttons button.error{background:linear-gradient(180deg,#b44a48,#78302f);border-color:rgba(255,135,129,.4)}')
    .replace('@media(max-width:900px){.metric-value{font-size:64px}', '@media(max-width:900px){.metric-value{font-size:62px}')
    .replace('.dose-buttons button{width:55px;height:25px}', '.dose-buttons button{width:68px;height:31px}')
    .replace('.dose-buttons b{font-size:8px}', '.dose-buttons b{font-size:10px}')
    .replace('.dose-buttons small{font-size:5px}', '.dose-buttons small{font-size:6px}');

  value = value
    .replace(/ onclick="return window\.poolPhManualDose\((?:60|120|180),this\)"/g, '')
    .replace(/<script data-ipad-final="1">[\s\S]*?<\/script>/g, '');

  const handler = buildInlineHandler(namespace);
  value = value.replace('<div class="dose-buttons">', `<div class="dose-buttons" onclick="${handler}">`);
  return value;
}

function install(adapter) {
  if (!adapter || adapter.__ipadFinal046Installed) return adapter;
  adapter.__ipadFinal046Installed = true;

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    try {
      const state = await adapter.getStateAsync(STATE_ID);
      const current = String((state && state.val) || '');
      const patched = patchHtml(current, adapter.namespace);
      if (!patched.includes('class="dose-buttons" onclick="') || patched.includes('window.poolPhManualDose')) {
        throw new Error('direkter Button-Handler wurde nicht vollständig eingebaut');
      }
      await adapter.setStateIfChanged(STATE_ID, patched, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[IPAD-MINI] Direkter Dosierbutton-Fix fehlgeschlagen: ' + (error.message || error));
      }
    }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [2200, 5200]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
          await adapter.forceImmediateRender();
        } catch (error) {
          if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
            adapter.log.warn('[IPAD-MINI] Start-Render 0.4.46 fehlgeschlagen: ' + (error.message || error));
          }
        }
      }, delay));
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

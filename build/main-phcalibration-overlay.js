'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.23';
const OVERLAY_STATE = 'vis.htmlPhCalibrationOverlay';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22)/g, VERSION);
}

function buildOverlayHtml(namespace) {
  const ns = JSON.stringify(namespace);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}button{width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}</style></head><body><button id="open" aria-label="PoolLab pH-Wert erfassen" title="PoolLab pH-Wert erfassen"></button><script>(function(){var ns=${ns},lock=0;function wins(){var a=[window];try{if(window.parent&&window.parent!==window)a.push(window.parent)}catch(e){}try{if(window.top&&window.top!==window.parent&&window.top!==window)a.push(window.top)}catch(e){}return a}function vis(){var a=wins();for(var i=0;i<a.length;i++){try{if(a[i].vis)return a[i].vis}catch(e){}}return null}async function setState(id,val){var a=wins(),v=vis();try{if(v&&typeof v.setValue==='function'){var r=v.setValue(id,val);if(r&&typeof r.then==='function')await r;return true}}catch(e){}for(var i=0;i<a.length;i++){try{var c=a[i].vis&&a[i].vis.conn;if(c&&typeof c.setState==='function'){var x=c.setState(id,val);if(x&&typeof x.then==='function')await x;return true}}catch(e){}}return false}function host(){var a=wins();for(var i=a.length-1;i>=0;i--){try{if(a[i].document&&a[i].document.body)return a[i]}catch(e){}}return window}function open(){var now=Date.now();if(now-lock<700)return;lock=now;var w=host(),d=w.document;if(d.getElementById('poollabOverlay23'))return;var o=d.createElement('div');o.id='poollabOverlay23';o.style.cssText='position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.68);display:flex;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif';o.innerHTML='<div style="width:min(360px,100%);background:linear-gradient(145deg,#173957,#0d2034);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:18px;padding:18px;box-shadow:0 18px 55px rgba(0,0,0,.45)"><div style="font-size:19px;font-weight:900">PoolLab pH-Wert erfassen</div><div style="font-size:12px;color:#a9bfd2;margin-top:4px">Der aktuelle PH803-Rohwert wird automatisch übernommen.</div><input id="poollabInput23" inputmode="decimal" autocomplete="off" placeholder="7,23" style="width:100%;height:58px;margin:16px 0 12px;border:1px solid rgba(92,203,255,.45);border-radius:12px;background:#071522;color:#fff;padding:8px 12px;font-size:30px;font-weight:900;outline:none"><div id="poollabMsg23" style="min-height:18px;font-size:12px;color:#ffd0c8;margin-bottom:8px"></div><div style="display:flex;gap:10px"><button id="poollabCancel23" style="flex:1;height:46px;border:0;border-radius:11px;background:#30445b;color:#fff;font-weight:800">Abbrechen</button><button id="poollabSave23" style="flex:1;height:46px;border:0;border-radius:11px;background:linear-gradient(135deg,#248bd3,#20bba7);color:#fff;font-weight:900">Speichern</button></div></div>';d.body.appendChild(o);var input=d.getElementById('poollabInput23'),save=d.getElementById('poollabSave23'),cancel=d.getElementById('poollabCancel23'),msg=d.getElementById('poollabMsg23');function close(){try{o.remove()}catch(e){if(o.parentNode)o.parentNode.removeChild(o)}}cancel.onclick=close;o.onclick=function(e){if(e.target===o)close()};save.onclick=async function(){var value=Number(String(input.value||'').trim().replace(',','.'));if(!Number.isFinite(value)||value<0||value>14){msg.textContent='Bitte einen gültigen pH-Wert zwischen 0 und 14 eingeben.';input.focus();return}save.disabled=true;save.textContent='Speichere …';msg.textContent='';var ok1=await setState(ns+'.control.ph.calibration.poollabValue',value);var ok2=ok1?await setState(ns+'.control.ph.calibration.saveTrigger',Date.now()):false;if(!ok1||!ok2){save.disabled=false;save.textContent='Speichern';msg.textContent='Speichern nicht möglich: VIS-Verbindung fehlt.';return}save.textContent='Gespeichert';setTimeout(close,500)};input.addEventListener('keydown',function(e){if(e.key==='Enter')save.click();if(e.key==='Escape')close()});setTimeout(function(){try{input.focus()}catch(e){}},80)}var b=document.getElementById('open');b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();open()},false);b.addEventListener('touchend',function(e){e.preventDefault();e.stopPropagation();open()},{passive:false})})();</script></body></html>`;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationOverlayInstalled) return adapter;
  adapter.__phCalibrationOverlayInstalled = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function writeOverlay() {
    await adapter.ensureState(OVERLAY_STATE, 'string', 'html', '', false);
    await adapter.setStateIfChanged(OVERLAY_STATE, buildOverlayHtml(adapter.namespace), true);
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try { await writeOverlay(); }
      catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[PH-KAL] Overlay konnte nicht erzeugt werden: ' + (error.message || error));
      }
    }, 5500));
  });

  try { adapter.log.info('[PH-KAL] v0.4.23: separate transparente PoolLab-Klickfläche aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

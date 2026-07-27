'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.27';
const FIELD_STATE = 'vis.htmlPhCalibrationField';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26)/g, VERSION);
}

function buildFieldHtml(namespace) {
  const ns = JSON.stringify(namespace);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.row{width:100%;height:100%;min-height:54px;display:grid;grid-template-columns:auto 78px 1fr;gap:7px;align-items:center;padding:7px 9px;border:1px solid rgba(255,255,255,.14);border-radius:13px;background:linear-gradient(180deg,#173457,#0c2038);box-shadow:0 7px 18px rgba(0,0,0,.28);color:#fff}.label{font-size:13px;font-weight:900;white-space:nowrap}.input{width:78px;height:38px;border:1px solid #55c8ff;border-radius:8px;background:#061524;color:#fff;padding:4px 7px;font-size:20px;font-weight:900;outline:none}.save{height:38px;border:0;border-radius:8px;background:linear-gradient(135deg,#258bd1,#20b9a6);color:#fff;font-size:12px;font-weight:900;padding:0 10px}.save:disabled{opacity:.65}</style></head><body><div class="row"><div class="label">PoolLab pH</div><input id="value" class="input" inputmode="decimal" autocomplete="off" placeholder="7,23"><button id="save" class="save" type="button">Speichern</button></div><script>(function(){var ns=${ns},lock=0,input=document.getElementById('value'),button=document.getElementById('save');function contexts(){var list=[window];try{if(window.parent&&window.parent!==window)list.push(window.parent)}catch(e){}try{if(window.top&&window.top!==window&&window.top!==window.parent)list.push(window.top)}catch(e){}return list}async function setState(id,value){var list=contexts();for(var i=0;i<list.length;i++){try{var v=list[i].vis;if(v&&typeof v.setValue==='function'){var r=v.setValue(id,value);if(r&&typeof r.then==='function')await r;return true}}catch(e){}try{var c=list[i].vis&&list[i].vis.conn;if(c&&typeof c.setState==='function'){var x=c.setState(id,value);if(x&&typeof x.then==='function')await x;return true}}catch(e){}}return false}async function save(ev){try{if(ev){ev.preventDefault();ev.stopPropagation()}}catch(e){}var now=Date.now();if(now-lock<700)return;lock=now;var value=Number(String(input.value||'').trim().replace(',','.'));if(!Number.isFinite(value)||value<0||value>14){button.textContent='Ungültig';input.focus();setTimeout(function(){button.textContent='Speichern'},1200);return}button.disabled=true;button.textContent='Speichere';var ok1=await setState(ns+'.control.ph.calibration.poollabValue',value);var ok2=ok1?await setState(ns+'.control.ph.calibration.saveTrigger',Date.now()):false;if(ok1&&ok2){button.textContent='Gespeichert';input.value=''}else{button.textContent='Fehler'}setTimeout(function(){button.disabled=false;button.textContent='Speichern'},1400)}button.addEventListener('click',save);try{button.addEventListener('touchend',save,{passive:false})}catch(e){}input.addEventListener('keydown',function(e){if(e.key==='Enter')save(e)});})();</script></body></html>`;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationInputInstalled) return adapter;
  adapter.__phCalibrationInputInstalled = true;
  adapter.__phCalibrationFieldReadyLogged = false;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function writeField() {
    const objectDefinition = {
      type: 'state',
      common: {
        name: 'PoolLab pH Eingabefeld',
        type: 'string',
        role: 'html',
        read: true,
        write: false,
        def: ''
      },
      native: {}
    };

    if (typeof adapter.setObjectNotExistsAsync === 'function') {
      await adapter.setObjectNotExistsAsync(FIELD_STATE, objectDefinition);
    } else {
      await adapter.ensureState(FIELD_STATE, 'string', 'html', '', false);
    }

    await adapter.setStateAsync(FIELD_STATE, buildFieldHtml(adapter.namespace), true);
    const check = await adapter.getStateAsync(FIELD_STATE);
    if (!check || !String(check.val || '').includes('PoolLab pH')) {
      throw new Error('State wurde nicht angelegt oder nicht befüllt');
    }

    if (!adapter.__phCalibrationFieldReadyLogged) {
      adapter.__phCalibrationFieldReadyLogged = true;
      adapter.log.info(`[PH-KAL] Eingabefeld bereit: ${adapter.namespace}.${FIELD_STATE}`);
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRenderVisFull = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRenderVisFull(...args);
      try {
        await writeField();
      } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[PH-KAL] Eingabefeld konnte beim VIS-Render nicht erzeugt werden: ' + (error.message || error));
      }
      return result;
    };
  }

  adapter.on('ready', () => {
    for (const delay of [1500, 6000, 15000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          await writeField();
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
          if (delay === 1500) await adapter.forceImmediateRender();
        } catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn(`[PH-KAL] Eingabefeld nach ${delay} ms nicht erzeugt: ` + (error.message || error));
        }
      }, delay));
    }
  });

  try { adapter.log.info('[PH-KAL] v0.4.27: PoolLab-Eingabefeld wird bei jedem VIS-Render geprüft'); } catch {}
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

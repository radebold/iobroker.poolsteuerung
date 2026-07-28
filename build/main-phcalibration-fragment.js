'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.33';
const HTML_STATE = 'vis.htmlPhCalibrationField';
const WIDGET_STATE = 'vis.widgetPhCalibrationField';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.\d+/g, VERSION);
}

function buildFragment(namespace) {
  const inputId = `${namespace}.control.ph.calibration.poollabValue`;
  const triggerId = `${namespace}.control.ph.calibration.saveTrigger`;
  const handler = `(async function(b){var i=b.previousElementSibling,v=Number(String(i.value||'').trim().replace(',','.'));if(!Number.isFinite(v)||v<0||v>14){b.textContent='Ungültig';i.focus();setTimeout(function(){b.textContent='Speichern'},1200);return}b.disabled=true;b.textContent='Speichere';var w=[window];try{if(window.parent&&window.parent!==window)w.push(window.parent)}catch(e){}try{if(window.top&&window.top!==window&&window.top!==window.parent)w.push(window.top)}catch(e){}async function s(id,val){for(var x=0;x<w.length;x++){try{var z=w[x].vis;if(z&&typeof z.setValue==='function'){var r=z.setValue(id,val);if(r&&typeof r.then==='function')await r;return true}}catch(e){}try{var c=w[x].vis&&w[x].vis.conn;if(c&&typeof c.setState==='function'){var q=c.setState(id,val);if(q&&typeof q.then==='function')await q;return true}}catch(e){}}return false}var a=await s('${inputId}',v),c=a?await s('${triggerId}',Date.now()):false;b.textContent=a&&c?'Gespeichert':'Fehler';if(a&&c)i.value='';setTimeout(function(){b.disabled=false;b.textContent='Speichern'},1400)})(this);return false;`;
  return `<div style="width:100%;height:100%;min-height:54px;display:grid;grid-template-columns:auto 78px 1fr;gap:7px;align-items:center;padding:7px 9px;box-sizing:border-box;border:1px solid rgba(255,255,255,.14);border-radius:13px;background:linear-gradient(180deg,#173457,#0c2038);box-shadow:0 7px 18px rgba(0,0,0,.28);color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><span style="font-size:13px;font-weight:900;white-space:nowrap">PoolLab pH</span><input inputmode="decimal" autocomplete="off" placeholder="7,23" style="width:78px;height:38px;box-sizing:border-box;border:1px solid #55c8ff;border-radius:8px;background:#061524;color:#fff;padding:4px 7px;font-size:20px;font-weight:900;outline:none"><button type="button" onclick="${handler.replace(/"/g, '&quot;')}" style="height:38px;border:0;border-radius:8px;background:linear-gradient(135deg,#258bd1,#20b9a6);color:#fff;font-size:12px;font-weight:900;padding:0 10px;cursor:pointer">Speichern</button></div>`;
}

function buildHtml(namespace) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}</style></head><body>${buildFragment(namespace)}</body></html>`;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationFragmentInstalled) return adapter;
  adapter.__phCalibrationFragmentInstalled = true;
  adapter.__phCalibrationFragmentLogged = false;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function ensureHtmlState(id, name) {
    const objectDefinition = {
      type: 'state',
      common: { name, type: 'string', role: 'html', read: true, write: false, def: '' },
      native: {}
    };
    if (typeof adapter.setObjectNotExistsAsync === 'function') {
      await adapter.setObjectNotExistsAsync(id, objectDefinition);
    } else {
      await adapter.ensureState(id, 'string', 'html', '', false);
    }
  }

  async function writeFields() {
    await ensureHtmlState(HTML_STATE, 'PoolLab pH Eingabefeld (HTML)');
    await ensureHtmlState(WIDGET_STATE, 'PoolLab pH Eingabefeld (VIS-Fragment)');
    await adapter.setStateAsync(HTML_STATE, buildHtml(adapter.namespace), true);
    await adapter.setStateAsync(WIDGET_STATE, buildFragment(adapter.namespace), true);

    const widget = await adapter.getStateAsync(WIDGET_STATE);
    if (!widget || !String(widget.val || '').includes('PoolLab pH')) {
      throw new Error('VIS-Fragment wurde nicht angelegt oder nicht befüllt');
    }
    if (!adapter.__phCalibrationFragmentLogged) {
      adapter.__phCalibrationFragmentLogged = true;
      adapter.log.info(`[PH-KAL] Eingabefeld bereit: ${adapter.namespace}.${WIDGET_STATE}`);
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRenderVisFull = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRenderVisFull(...args);
      try { await writeFields(); }
      catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[PH-KAL] Eingabefeld konnte beim VIS-Render nicht erzeugt werden: ' + (error.message || error));
      }
      return result;
    };
  }

  adapter.on('ready', () => {
    for (const delay of [1200, 5000, 12000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          await writeFields();
          if (delay === 1200) {
            adapter.lastRenderSignature = '';
            adapter.lastRenderAt = 0;
            await adapter.forceImmediateRender();
          }
        } catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn(`[PH-KAL] Eingabefeld nach ${delay} ms nicht erzeugt: ` + (error.message || error));
        }
      }, delay));
    }
  });

  try { adapter.log.info('[PH-KAL] v0.4.33: HTML- und VIS-Fragment für PoolLab bereit'); } catch {}
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

const createBase = require('./main-ipadmini-final.js');

const VERSION = 'v0.4.47';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function buildDoseHandler(namespace, seconds) {
  const dose = Math.max(1, Number(seconds) || 30);
  const ns = String(namespace || 'poolsteuerung.0').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const code = [
    "var b=this,l=b.querySelector('b'),s=b.querySelector('small')",
    "var v=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    "var ol=l?l.textContent:'" + dose + " Sek.',os=s?s.textContent:'Start Dosierung'",
    "if(!v){if(l)l.textContent='Fehler';if(s)s.textContent='VIS nicht verfügbar';return false}",
    "b.disabled=true;if(l)l.textContent='…';if(s)s.textContent='wird gestartet'",
    "function w(id,val){if(typeof v.setValue==='function')return Promise.resolve(v.setValue(id,val));if(v.conn&&typeof v.conn.setState==='function')return Promise.resolve(v.conn.setState(id,val));return Promise.reject(new Error('setState nicht verfügbar'))}",
    "function reset(){setTimeout(function(){if(l)l.textContent=ol;if(s)s.textContent=os;b.disabled=false;b.classList.remove('success','error')},1800)}",
    "w('" + ns + ".control.ph.manualDoseSec'," + dose + ").then(function(){return w('" + ns + ".control.ph.manualTrigger',Date.now())}).then(function(){b.classList.add('success');if(l)l.textContent='Gestartet';if(s)s.textContent='" + dose + " Sekunden';reset()},function(){b.classList.add('error');if(l)l.textContent='Fehler';if(s)s.textContent='nicht ausgelöst';reset()})",
    "return false"
  ].join(';');
  return escapeAttribute(code);
}

function patchIpadHtml(html, namespace) {
  let value = String(html || '');
  if (!value.includes('data-ipad-final="1"') || !value.includes('data-dose="60"')) return value;

  value = value.replace(/v0\.4\.\d+/g, VERSION);
  value = value.replace(/<script data-ipad-final="1">[\s\S]*?<\/script>/g, '');
  value = value.replace(/\s+onclick="[^"]*"/g, '');

  for (const seconds of [60, 120, 180]) {
    const handler = buildDoseHandler(namespace, seconds);
    const buttonPattern = new RegExp(`<button([^>]*?)data-dose="${seconds}"([^>]*)>`, 'g');
    value = value.replace(buttonPattern, `<button$1data-dose="${seconds}"$2 onclick="${handler}">`);
  }

  value = value
    .replace('.dose-buttons button:disabled{opacity:.6}', '.dose-buttons button:disabled{opacity:.75;cursor:default}.dose-buttons button.success{background:linear-gradient(180deg,#269258,#17643d);border-color:rgba(105,238,153,.38)}.dose-buttons button.error{background:linear-gradient(180deg,#b44a48,#78302f);border-color:rgba(255,135,129,.4)}')
    .replace('font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif', 'font-family:"Segoe UI Variable","Segoe UI",-apple-system,BlinkMacSystemFont,Arial,sans-serif')
    .replace('.metric-label{font-size:17px;font-weight:850}', '.metric-label{font-size:17px;font-weight:700;letter-spacing:-.01em}')
    .replace('.metric-value{font-size:73px;font-weight:900;', '.metric-value{font-size:70px;font-weight:760;')
    .replace('.metric-unit{font-size:25px;font-weight:850;', '.metric-unit{font-size:24px;font-weight:650;')
    .replace('.metric-trend{font-size:29px;font-weight:900;', '.metric-trend{font-size:27px;font-weight:650;')
    .replace('.dose-buttons button{width:62px;height:28px;', '.dose-buttons button{width:72px;height:32px;')
    .replace('.dose-buttons b{font-size:9px;', '.dose-buttons b{font-size:10px;font-weight:700;')
    .replace('.dose-buttons small{font-size:6px;', '.dose-buttons small{font-size:7px;font-weight:500;');

  return value;
}

async function patchState(adapter, id) {
  const state = await adapter.getStateAsync(id);
  const current = String((state && state.val) || '');
  if (!current) return;
  const next = id === 'vis.htmlIpadMini'
    ? patchIpadHtml(current, adapter.namespace)
    : current.replace(/v0\.4\.\d+/g, VERSION);
  if (next !== current) await adapter.setStateIfChanged(id, next, true);
}

function install(adapter) {
  if (!adapter || adapter.__ipadFinal047Installed) return adapter;
  adapter.__ipadFinal047Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => String(original({ ...(data || {}), adapterVersion: VERSION })).replace(/v0\.4\.\d+/g, VERSION);
  }

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    try {
      for (const id of VIS_STATES) await patchState(adapter, id);
      const ipad = await adapter.getStateAsync('vis.htmlIpadMini');
      const html = String((ipad && ipad.val) || '');
      if (!html.includes('data-dose="60"') || !html.includes('onclick="') || html.includes('<script data-ipad-final="1">')) {
        throw new Error('iPad-Dosierhandler wurde nicht vollständig erzeugt');
      }
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[IPAD-MINI] Dosier-/Versionsfix 0.4.47 fehlgeschlagen: ' + (error.message || error));
      }
    }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [1800, 5000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
          await adapter.forceImmediateRender();
        } catch (error) {
          if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
            adapter.log.warn('[IPAD-MINI] Start-Render 0.4.47 fehlgeschlagen: ' + (error.message || error));
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

'use strict';

const createBase = require('./main-ipadmini-final-505.js');

let CURRENT = '0.5.6';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}

const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone'];

function escapeAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, ' ');
}

function clickHandler(namespace) {
  const checkId = `${namespace}.update.checkTrigger`.replace(/'/g, "\\'");
  const installId = `${namespace}.update.installTrigger`.replace(/'/g, "\\'");

  return escapeAttribute(
    `event.preventDefault();event.stopPropagation();` +
    `var b=this,u=b.dataset.available==='1',id=u?'${installId}':'${checkId}',val=Date.now();` +
    `if(u&&!confirm('Poolsteuerung auf Version '+(b.dataset.target||'neu')+' aktualisieren?'))return false;` +
    `b.textContent=u?'START …':'PRÜFE …';b.disabled=true;` +
    `var sent=false,p=null,v=null;` +
    `try{if(window.vis)v=window.vis;}catch(e){}` +
    `try{if(!v&&window.parent&&window.parent.vis)v=window.parent.vis;}catch(e){}` +
    `try{if(!v&&window.top&&window.top.vis)v=window.top.vis;}catch(e){}` +
    `try{if(v&&v.conn&&typeof v.conn.setState==='function'){p=v.conn.setState(id,val);sent=true;}}catch(e){}` +
    `try{if(!sent&&v&&typeof v.setValue==='function'){p=v.setValue(id,val);sent=true;}}catch(e){}` +
    `try{if(!sent&&typeof window.poolSetState==='function'){p=window.poolSetState(id,val);sent=true;}}catch(e){}` +
    `if(!sent){b.disabled=false;b.textContent=u?'UPDATE '+(b.dataset.target||''):'AKTUELL';alert('Update-Auftrag konnte nicht an ioBroker geschrieben werden.');return false;}` +
    `if(p&&typeof p.then==='function'){p.catch(function(e){b.disabled=false;b.textContent=u?'UPDATE '+(b.dataset.target||''):'AKTUELL';alert('Update-Auftrag fehlgeschlagen: '+(e&&e.message?e.message:e));});}` +
    `setTimeout(function(){b.disabled=false;},3000);return false;`
  );
}

function patchButton(value, namespace) {
  let html = String(value || '');
  if (!html) return html;
  const handler = clickHandler(namespace);

  html = html.replace(/<button\b(?=[^>]*data-pool-update-068="1")[^>]*>/gi, tag => {
    let next = tag
      .replace(/\s+onclick="[^"]*"/i, '')
      .replace(/\s+ontouchend="[^"]*"/i, '');
    return next.replace(/>$/, ` onclick="${handler}">`);
  });

  return html;
}

function install(adapter) {
  if (!adapter || adapter.__update506ClickFixInstalled) return adapter;
  adapter.__update506ClickFixInstalled = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchButton(original(data), adapter.namespace);
  }

  async function patchExisting() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = patchButton(current, adapter.namespace);
        if (next && next !== current) await adapter.setStateAsync(id, next, true);
      } catch {}
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExisting();
      return result;
    };
  }

  let attempts = 0;
  const start = () => {
    const timer = setTimeout(async () => {
      attempts += 1;
      if (adapter.isShuttingDown) return;
      try {
        await patchExisting();
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
        await patchExisting();
        adapter.log.info(`[UPDATE ${CURRENT}] Klickhandler-Fix aktiv: vis.conn.setState zuerst`);
      } catch (error) {
        if (attempts < 10) start();
      }
    }, attempts ? 1500 : 2500);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  };
  start();

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

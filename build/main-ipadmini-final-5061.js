'use strict';

const createBase = require('./main-ipadmini-final-506.js');

let CURRENT = '0.5.6';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}

const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone'];

function attr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, ' ');
}

function handler(namespace) {
  const checkId = `${namespace}.update.checkTrigger`.replace(/'/g, "\\'");
  const installId = `${namespace}.update.installTrigger`.replace(/'/g, "\\'");
  return attr(
    `event.preventDefault();event.stopPropagation();` +
    `var b=this;if(b.dataset.firing==='1')return false;b.dataset.firing='1';setTimeout(function(){b.dataset.firing='0';},1200);` +
    `var u=b.dataset.available==='1',id=u?'${installId}':'${checkId}',val=Date.now();` +
    `if(u&&!confirm('Poolsteuerung auf Version '+(b.dataset.target||'neu')+' aktualisieren?')){b.dataset.firing='0';return false;}` +
    `b.textContent=u?'START …':'PRÜFE …';` +
    `var v=null,ok=false;` +
    `try{if(window.vis)v=window.vis;}catch(e){}` +
    `try{if(!v&&window.parent&&window.parent.vis)v=window.parent.vis;}catch(e){}` +
    `try{if(!v&&window.top&&window.top.vis)v=window.top.vis;}catch(e){}` +
    `try{if(v&&v.conn&&typeof v.conn.setState==='function'){v.conn.setState(id,val);ok=true;}}catch(e){}` +
    `try{if(v&&typeof v.setValue==='function'){v.setValue(id,val);ok=true;}}catch(e){}` +
    `try{if(typeof window.poolSetState==='function'){window.poolSetState(id,val);ok=true;}}catch(e){}` +
    `if(!ok){b.textContent=u?'UPDATE '+(b.dataset.target||''):'AKTUELL';alert('VIS-State-Schreibfunktion nicht gefunden.');}` +
    `return false;`
  );
}

function patch(value, namespace) {
  let html = String(value || '');
  if (!html) return html;
  const h = handler(namespace);
  html = html.replace(/<button\b(?=[^>]*data-pool-update-068="1")[^>]*>/gi, tag => {
    let next = tag
      .replace(/\s+onclick="[^"]*"/gi, '')
      .replace(/\s+onpointerdown="[^"]*"/gi, '')
      .replace(/\s+ontouchstart="[^"]*"/gi, '')
      .replace(/\s+ontouchend="[^"]*"/gi, '')
      .replace(/\s+style="[^"]*"/gi, '');
    return next.replace(/>$/, ` style="pointer-events:auto!important;position:relative!important;z-index:9999!important;touch-action:manipulation!important;cursor:pointer!important" onpointerdown="${h}" ontouchstart="${h}" onclick="${h}">`);
  });
  return html;
}

function install(adapter) {
  if (!adapter || adapter.__update5061ClickFixInstalled) return adapter;
  adapter.__update5061ClickFixInstalled = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patch(original(data), adapter.namespace);
  }

  async function patchExisting() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const cur = String((state && state.val) || '');
        const next = patch(cur, adapter.namespace);
        if (next && next !== cur) await adapter.setStateAsync(id, next, true);
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

  let tries = 0;
  const run = () => {
    const timer = setTimeout(async () => {
      if (adapter.isShuttingDown) return;
      tries += 1;
      try {
        await patchExisting();
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
        await patchExisting();
        adapter.log.info(`[UPDATE ${CURRENT}] Klickfix 2 aktiv: pointer/touch/click + alle VIS-Schreibwege`);
      } catch {
        if (tries < 10) run();
      }
    }, tries ? 1500 : 2200);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  };
  run();

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

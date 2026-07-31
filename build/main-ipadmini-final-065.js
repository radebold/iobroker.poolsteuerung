'use strict';

const createBase = require('./main-ipadmini-final-064.js');

const VERSION = 'v0.4.65';
const MOBILE_STATES = ['vis.htmlPhone', 'vis.widgetPhone'];
const ALL_VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', ...MOBILE_STATES, 'vis.htmlIpadMini'];

const COMPACT_STYLE = `<style data-mobile-actor-compact="1">
/* Mobile: Aktoren & Status auf dieselbe Zeilenhöhe wie Automatik bringen. */
.status-grid{grid-auto-rows:46px!important;align-items:stretch!important}
.status-grid .action-btn{position:relative!important;height:46px!important;min-height:46px!important;padding:6px 10px!important;gap:1px!important;overflow:hidden!important}
.status-grid .action-sync{position:absolute!important;top:5px!important;right:8px!important;margin:0!important;max-width:38px!important;font-size:8px!important;line-height:1!important;white-space:nowrap!important}
.status-grid .action-name{padding-right:38px!important;font-size:12px!important;line-height:1.05!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.status-grid .action-state{font-size:9px!important;line-height:1!important}
.ps-statusGrid{grid-auto-rows:44px!important;align-items:stretch!important}
.ps-statusGrid .ps-btn{position:relative!important;height:44px!important;min-height:44px!important;padding:6px 9px!important;gap:1px!important;overflow:hidden!important}
.ps-statusGrid .ps-sync{position:absolute!important;top:5px!important;right:7px!important;margin:0!important;max-width:36px!important;font-size:8px!important;line-height:1!important;white-space:nowrap!important}
.ps-statusGrid .ps-btn-name{padding-right:36px!important;line-height:1.05!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.ps-statusGrid .ps-btn-state{line-height:1!important}
.ps-statuswrap{grid-auto-rows:58px!important;align-items:stretch!important}
.ps-statuswrap .ps-action-btn{height:58px!important;min-height:58px!important}
</style>`;

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function patchMobile(value) {
  let html = patchVersion(value);
  if (!html) return html;
  html = html.replace(/<style data-mobile-actor-compact="1">[\s\S]*?<\/style>/g, '');
  if (!html.includes('Aktoren & Status')) return html;
  return `${html}${COMPACT_STYLE}`;
}

async function patchExistingStates(adapter) {
  for (const id of ALL_VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = MOBILE_STATES.includes(id) ? patchMobile(current) : patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.debug === 'function') {
        adapter.log.debug(`[MOBILE] Kompakt-Fix für ${id} fehlgeschlagen: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__mobileActorCompact065Installed) return adapter;
  adapter.__mobileActorCompact065Installed = true;

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchMobile(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates(adapter);
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      try { await adapter.forceImmediateRender(); } catch {}
      try { await patchExistingStates(adapter); } catch {}
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

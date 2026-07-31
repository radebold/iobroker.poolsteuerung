'use strict';

const createBase = require('./main-ipadmini-final-065.js');

const VERSION = 'v0.4.66';
const MOBILE_STATES = ['vis.htmlPhone', 'vis.widgetPhone'];
const ALL_VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', ...MOBILE_STATES, 'vis.htmlIpadMini'];

const STYLE = `<style data-mobile-ph-info-top="1">
/* Mobile: WhatsApp-Schalter platzsparend neben der Pooltemperatur. */
.temp-row.ph-info-host,.ps-tempRow.ph-info-host{position:relative!important}
.temp-row.ph-info-host{padding-right:118px!important}
.temp-row.ph-info-host .ph-info-compact{position:absolute!important;left:58%!important;top:50%!important;transform:translate(-50%,-50%)!important;margin:0!important}
.ps-tempRow.ph-info-host{padding-right:96px!important}
.ps-tempRow.ph-info-host .ph-info-compact{position:absolute!important;right:4px!important;top:50%!important;transform:translateY(-50%)!important;margin:0!important}
.ph-wa-flag.ph-info-compact{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:6px!important;width:auto!important;min-width:88px!important;height:32px!important;padding:4px 9px!important;border-radius:999px!important;background:rgba(37,211,102,.13)!important;border:1px solid rgba(37,211,102,.38)!important;color:inherit!important;font-size:10px!important;font-weight:900!important;line-height:1!important;white-space:nowrap!important;cursor:pointer!important;user-select:none!important;z-index:8!important}
.ph-wa-flag.ph-info-compact input{width:17px!important;height:17px!important;margin:0!important;accent-color:#25d366!important;flex:0 0 17px!important}
.ph-wa-flag.ph-info-compact span{font-size:10px!important;line-height:1!important;white-space:nowrap!important}
@media(max-width:390px){.temp-row.ph-info-host .ph-info-compact{left:64%!important}.ph-wa-flag.ph-info-compact{min-width:82px!important;padding:4px 7px!important}}
</style>`;

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function extractPhInfoLabel(html) {
  const match = String(html || '').match(/<label class="ph-wa-flag(?: ph-info-compact)?"[\s\S]*?<\/label>/);
  if (!match) return '';
  return match[0]
    .replace(/class="ph-wa-flag(?: ph-info-compact)?"/, 'class="ph-wa-flag ph-info-compact"')
    .replace(/<span>(?:WhatsApp bei pH-Dosierung|PH-Info)<\/span>/, '<span>PH-Info</span>');
}

function removeOldPhInfo(html) {
  return String(html || '').replace(/\s*<label class="ph-wa-flag(?: ph-info-compact)?"[\s\S]*?<\/label>/g, '');
}

function patchPhoneHtml(htmlValue) {
  let html = patchVersion(htmlValue);
  if (!html) return html;

  html = html.replace(/<style data-mobile-ph-info-top="1">[\s\S]*?<\/style>/g, '');
  const label = extractPhInfoLabel(html);
  if (!label) return html;
  html = removeOldPhInfo(html);

  const tempRow = /<div class="temp-row(?: ph-info-host)?">(<div class="temp">[\s\S]*?<\/div><div class="unit">°C<\/div>)<\/div>/;
  const widgetTempRow = /<div class="ps-tempRow(?: ph-info-host)?">(<div class="ps-temp">[\s\S]*?<\/div><div class="ps-unit">°C<\/div>)<\/div>/;

  if (tempRow.test(html)) {
    html = html.replace(tempRow, `<div class="temp-row ph-info-host">$1${label}</div>`);
  } else if (widgetTempRow.test(html)) {
    html = html.replace(widgetTempRow, `<div class="ps-tempRow ph-info-host">$1${label}</div>`);
  } else {
    return html;
  }

  return `${html}${STYLE}`;
}

async function patchExistingStates(adapter) {
  for (const id of ALL_VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = MOBILE_STATES.includes(id) ? patchPhoneHtml(current) : patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.debug === 'function') {
        adapter.log.debug(`[MOBILE] PH-Info-Position für ${id} fehlgeschlagen: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__mobilePhInfoTop066Installed) return adapter;
  adapter.__mobilePhInfoTop066Installed = true;

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchPhoneHtml(original({ ...(data || {}), adapterVersion: VERSION }));
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

'use strict';

const createBase = require('./main-ipadmini-final-068.js');

const VERSION = 'v0.4.69';
const TABLET_STATES = ['vis.htmlTablet', 'vis.widgetTablet'];
const ALL_VIS_STATES = [...TABLET_STATES, 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

const STYLE = `<style data-tablet-ph-info-bottom-069="1">
/* Tablet: pH-WhatsApp neutral und platzsparend unten links. */
.col-left.ph-wa-host-069{height:100%!important;display:flex!important;flex-direction:column!important}
.ps-card.ps-hero.ph-wa-host-069{height:100%!important;display:flex!important;flex-direction:column!important}
.ph-wa-flag.ph-wa-tablet-bottom-069{display:flex!important;align-items:center!important;justify-content:flex-start!important;gap:8px!important;width:100%!important;min-height:34px!important;height:34px!important;margin:8px 0 0!important;padding:6px 10px!important;border-radius:12px!important;background:rgba(255,255,255,.055)!important;border:1px solid rgba(255,255,255,.09)!important;color:#c6d7ea!important;font-size:11px!important;font-weight:800!important;line-height:1!important;cursor:pointer!important;user-select:none!important;box-shadow:none!important;flex:0 0 34px!important}
.col-left.ph-wa-host-069>.ph-wa-tablet-bottom-069,.ps-card.ps-hero.ph-wa-host-069>.ph-wa-tablet-bottom-069{margin-top:auto!important}
.ph-wa-flag.ph-wa-tablet-bottom-069 input{width:17px!important;height:17px!important;margin:0!important;accent-color:#8da6c1!important;cursor:pointer!important;flex:0 0 17px!important}
.ph-wa-flag.ph-wa-tablet-bottom-069 span{font-size:11px!important;font-weight:800!important;line-height:1!important;white-space:nowrap!important}
</style>`;

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function findMatchingDivEnd(html, startIndex) {
  if (startIndex < 0) return -1;
  const token = /<div\b[^>]*>|<\/div>/gi;
  token.lastIndex = startIndex;
  let depth = 0;
  let match;
  while ((match = token.exec(html))) {
    if (/^<div\b/i.test(match[0])) depth += 1;
    else depth -= 1;
    if (depth === 0) return token.lastIndex;
  }
  return -1;
}

function extractPhInfoLabel(value) {
  const match = String(value || '').match(/<label\b[^>]*class="[^"]*\bph-wa-flag\b[^"]*"[^>]*>[\s\S]*?<\/label>/i);
  if (!match) return '';
  return match[0]
    .replace(/class="([^"]*)"/i, (_all, classes) => {
      const next = String(classes)
        .split(/\s+/)
        .filter(Boolean)
        .filter(name => name !== 'ph-wa-tablet-bottom-069');
      if (!next.includes('ph-wa-flag')) next.unshift('ph-wa-flag');
      next.push('ph-wa-tablet-bottom-069');
      return `class="${next.join(' ')}"`;
    })
    .replace(/title="[^"]*"/i, 'title="pH-Dosierungsinformationen per WhatsApp ein- oder ausschalten"')
    .replace(/<span>[\s\S]*?<\/span>/i, '<span>pH-Info</span>');
}

function removePhInfoLabels(value) {
  return String(value || '').replace(/\s*<label\b[^>]*class="[^"]*\bph-wa-flag\b[^"]*"[^>]*>[\s\S]*?<\/label>/gi, '');
}

function insertIntoNormalTablet(value, label) {
  let html = String(value || '').replace(/class="col-left\s+ph-wa-host-069"/g, 'class="col-left"');
  html = html.replace('<div class="col-left">', '<div class="col-left ph-wa-host-069">');
  const leftMatch = html.match(/<div class="col-left ph-wa-host-069">/);
  if (!leftMatch) return '';
  const leftStart = leftMatch.index;
  const middleMatch = /<div class="col-mid">/.exec(html.slice(leftStart + leftMatch[0].length));
  if (!middleMatch) return '';
  const middleStart = leftStart + leftMatch[0].length + middleMatch.index;
  const closing = html.lastIndexOf('</div>', middleStart);
  if (closing < leftStart) return '';
  return html.slice(0, closing) + label + html.slice(closing);
}

function insertIntoWidgetTablet(value, label) {
  let html = String(value || '').replace(/class="ps-card ps-hero\s+ph-wa-host-069"/g, 'class="ps-card ps-hero"');
  html = html.replace('<div class="ps-card ps-hero">', '<div class="ps-card ps-hero ph-wa-host-069">');
  const hero = /<div class="ps-card ps-hero ph-wa-host-069">/.exec(html);
  if (!hero) return '';
  const end = findMatchingDivEnd(html, hero.index);
  if (end < 0) return '';
  const closeStart = html.lastIndexOf('</div>', end);
  if (closeStart < hero.index) return '';
  return html.slice(0, closeStart) + label + html.slice(closeStart);
}

function patchTablet(value) {
  let html = patchVersion(value);
  if (!html) return html;

  html = html.replace(/<style data-tablet-ph-info-bottom-069="1">[\s\S]*?<\/style>/g, '');
  const label = extractPhInfoLabel(html);
  if (!label) return html;
  html = removePhInfoLabels(html);

  const normal = insertIntoNormalTablet(html, label);
  if (normal) html = normal;
  else {
    const widget = insertIntoWidgetTablet(html, label);
    if (!widget) return html;
    html = widget;
  }

  return html.includes('</head>') ? html.replace('</head>', `${STYLE}</head>`) : `${html}${STYLE}`;
}

async function patchExistingStates(adapter) {
  for (const id of ALL_VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = TABLET_STATES.includes(id) ? patchTablet(current) : patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.config.debugMode) {
        adapter.log.debug(`[TABLET] pH-Info unten links für ${id} fehlgeschlagen: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__tabletPhInfoBottom069Installed) return adapter;
  adapter.__tabletPhInfoBottom069Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchTablet(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
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
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info(`[TABLET] ${VERSION}: pH-Info neutral unten links; Schnellzugriff kompakter`);
      }
    }, 1900));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

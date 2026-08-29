'use strict';

/*
 * 0.6.0 – consolidated VIS architecture.
 *
 * There is exactly one runtime owner for all five VIS states. The historical
 * wrapper chain is still loaded for control/safety behaviour, but its VIS
 * builders, render wrappers and delayed post-writes are bypassed here.
 */
const { AsyncLocalStorage } = require('async_hooks');
const createLegacyRuntime = require('./main-ipadmini-final-573.js');
const { buildIpadMini } = require('./vis-ipad-builder-600.js');

const VERSION = 'v0.6.0';
const VIS_IDS = new Set([
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
]);

function localId(adapter, id) {
  const text = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function addClass(tag, className) {
  if (!tag || !className) return tag;
  if (/class="[^"]*"/.test(tag)) {
    return tag.replace(/class="([^"]*)"/, (_m, classes) => {
      const list = String(classes).split(/\s+/).filter(Boolean);
      if (!list.includes(className)) list.push(className);
      return `class="${list.join(' ')}"`;
    });
  }
  return tag.replace(/^<([a-z0-9-]+)/i, `<$1 class="${className}"`);
}

function firstPumpWindow(adapter) {
  const cfg = adapter.config || {};
  const rows = Array.isArray(cfg.pumpSchedules) ? cfg.pumpSchedules : [];
  const enabled = rows.find(row => row && row.enabled !== false && row.start && row.end);
  if (enabled) return `${enabled.start}–${enabled.end}`;
  if (cfg.pumpWindow1Start && cfg.pumpWindow1End) return `${cfg.pumpWindow1Start}–${cfg.pumpWindow1End}`;
  return '';
}

function patchPhoneGeneratedHtml(adapter, htmlValue, data) {
  let html = String(htmlValue || '');
  if (!html) return html;

  // The normal path gets VERSION through adapterVersion. This only removes the
  // one hard-coded base fallback literal if it appears in generated HTML.
  html = html.replace(/v0\.4\.1\b/g, VERSION);

  // Generate PH-Info at the desired position inside the builder output.
  const labelMatch = html.match(/<label\b[^>]*class="[^"]*\bph-wa-flag\b[^"]*"[^>]*>[\s\S]*?<\/label>/i);
  if (labelMatch) {
    const label = labelMatch[0]
      .replace(/<span>[\s\S]*?<\/span>/i, '<span>PH-Info</span>')
      .replace(/^<label\b[^>]*>/i, tag => addClass(tag, 'ph-info-single-owner'));
    html = html.replace(/\s*<label\b[^>]*class="[^"]*\bph-wa-flag\b[^"]*"[^>]*>[\s\S]*?<\/label>/gi, '');

    let inserted = false;
    html = html.replace(/(<div class="temp-row">[\s\S]*?)(<\/div>\s*<div class="scale">)/i, (_m, row, tail) => {
      if (inserted) return _m;
      inserted = true;
      return `${row}${label}</div>${tail.slice(6)}`;
    });
    if (!inserted) {
      html = html.replace(/(<div class="ps-tempRow">[\s\S]*?)(<\/div>\s*<div class="ps-scale">)/i, (_m, row, tail) => {
        if (inserted) return _m;
        inserted = true;
        return `${row}${label}</div>${tail.slice(6)}`;
      });
    }
  }

  // 24h pool temperature is generated from the render data that main.js has
  // already obtained. No second history fetch and no post-write HTML injection.
  const svg = String((data && data.poolTempSparklineSvg) || '').trim();
  if (svg.includes('<svg') && !html.includes('phone-temp-24h-single')) {
    const curve = `<div class="phone-temp-24h-single" aria-label="Pooltemperatur 24 Stunden">${svg}</div>`;
    let inserted = false;
    html = html.replace(/(<div class="temp-row[^>]*>[\s\S]*?)(<\/div>\s*<div class="scale">)/i, (_m, row, tail) => {
      if (inserted) return _m;
      inserted = true;
      return `${row}${curve}</div>${tail.slice(6)}`;
    });
    if (!inserted) {
      html = html.replace(/(<div class="ps-tempRow[^>]*>[\s\S]*?)(<\/div>\s*<div class="ps-scale">)/i, (_m, row, tail) => {
        if (inserted) return _m;
        inserted = true;
        return `${row}${curve}</div>${tail.slice(6)}`;
      });
    }
  }

  // Compact pH information is produced from the same render model instead of
  // parsing Tablet HTML or rewriting a VIS state after render.
  const interval = Math.max(5, Number(adapter.config && adapter.config.phCheckIntervalMin) || 30);
  if (data) {
    const last = data.phLastDoseTime && data.phLastDoseTime !== '-'
      ? `${data.phLastDoseTime} · ${data.phLastDoseMl || '0'} ml/${data.phLastDoseDurationSec || '0'}s`
      : 'noch keine';
    const next = `${data.phNextCheck || '-'} · alle ${interval} Min`;
    html = html.replace(/✔\s*Letzte:\s*<b>[\s\S]*?<\/b>\s*\([^)]*\)/i, `✔ Letzte: <b>${last}</b>`);
    html = html.replace(/⏰\s*Nächste:\s*<b>[\s\S]*?<\/b>/i, `⏰ Nächste: <b>${next}</b>`);
  }

  const window = firstPumpWindow(adapter);
  if (window) html = html.replace(/Poolwert von/gi, `Umwälzung ${window}`);

  const css = `<style data-single-vis-owner="0.6.0">
.temp-row,.ps-tempRow{position:relative!important}
.ph-info-single-owner{margin-left:auto!important;margin-right:0!important;align-self:center!important;justify-self:end!important;flex:0 0 auto!important}
.phone-temp-24h-single{position:absolute!important;left:0!important;right:0!important;bottom:-1px!important;height:18px!important;overflow:hidden!important;pointer-events:none!important;z-index:1!important;color:#76d7ff!important}
.phone-temp-24h-single svg,.phone-temp-24h-single .sparkline{display:block!important;width:100%!important;height:18px!important;max-width:none!important;overflow:hidden!important}
.phone-temp-24h-single path{fill:none!important;stroke:#76d7ff!important;stroke-width:1!important;stroke-linecap:round!important;stroke-linejoin:round!important}
.phone-temp-24h-single circle{display:none!important}
</style>`;
  html = html.replace(/<style data-single-vis-owner="0\.6\.0">[\s\S]*?<\/style>/g, '');
  return html.includes('</head>') ? html.replace('</head>', `${css}</head>`) : `${css}${html}`;
}

function install(adapter) {
  if (!adapter || adapter.__singleVis600Installed) return adapter;
  adapter.__singleVis600Installed = true;

  const proto = Object.getPrototypeOf(adapter);
  const baseBuilders = {
    buildTabletHtml: proto && typeof proto.buildTabletHtml === 'function' ? proto.buildTabletHtml : null,
    buildTabletWidget: proto && typeof proto.buildTabletWidget === 'function' ? proto.buildTabletWidget : null,
    buildPhoneHtml: proto && typeof proto.buildPhoneHtml === 'function' ? proto.buildPhoneHtml : null,
    buildPhoneWidget: proto && typeof proto.buildPhoneWidget === 'function' ? proto.buildPhoneWidget : null
  };
  const baseRenderVisFull = proto && typeof proto.renderVisFull === 'function' ? proto.renderVisFull : null;
  const baseForceImmediateRender = proto && typeof proto.forceImmediateRender === 'function' ? proto.forceImmediateRender : null;

  if (!baseRenderVisFull || Object.values(baseBuilders).some(fn => typeof fn !== 'function')) {
    throw new Error('[VIS 0.6.0] canonical base generator methods not found on Poolsteuerung prototype');
  }

  const rawSetStateAsync = adapter.setStateAsync.bind(adapter);
  const previousSetStateIfChanged = adapter.setStateIfChanged.bind(adapter);
  const ownerContext = new AsyncLocalStorage();
  let blockedLegacyWrites = 0;
  let lastBlocked = '';
  let canonicalData = null;

  function isCanonicalWrite() {
    const store = ownerContext.getStore();
    return !!store && store.owner === 'single-vis-0.6.0';
  }

  // Hard ownership boundary. AsyncLocalStorage is important here: a legacy
  // timeout firing while a canonical render awaits I/O is still outside the
  // canonical async context and therefore remains blocked.
  adapter.setStateAsync = async function singleVisStateOwner(id, value, ack, ...rest) {
    const local = localId(adapter, id);
    if (VIS_IDS.has(local) && !isCanonicalWrite()) {
      blockedLegacyWrites += 1;
      lastBlocked = `${local} · ${new Date().toISOString()}`;
      return { id: String(id), notChanged: true, blockedBy: 'single-vis-owner-0.6.0' };
    }
    return rawSetStateAsync(id, value, ack, ...rest);
  };

  adapter.setStateIfChanged = async function singleVisStateIfChanged(id, value, ack = true, ...rest) {
    const local = localId(adapter, id);
    if (VIS_IDS.has(local) && !isCanonicalWrite()) {
      blockedLegacyWrites += 1;
      lastBlocked = `${local} · ${new Date().toISOString()}`;
      return false;
    }
    return previousSetStateIfChanged(id, value, ack, ...rest);
  };

  // These four functions are the only active HTML/widget builders for the main
  // dashboard. They call the untouched Poolsteuerung prototype directly, not a
  // wrapper from the historical chain.
  adapter.buildTabletHtml = function buildTabletHtmlSingle(data) {
    canonicalData = { ...(data || {}), adapterVersion: VERSION, namespace: adapter.namespace };
    return String(baseBuilders.buildTabletHtml.call(adapter, canonicalData));
  };
  adapter.buildTabletWidget = function buildTabletWidgetSingle(data) {
    return String(baseBuilders.buildTabletWidget.call(adapter, { ...(data || {}), adapterVersion: VERSION }));
  };
  adapter.buildPhoneHtml = function buildPhoneHtmlSingle(data) {
    const next = { ...(data || {}), adapterVersion: VERSION };
    return patchPhoneGeneratedHtml(adapter, baseBuilders.buildPhoneHtml.call(adapter, next), next);
  };
  adapter.buildPhoneWidget = function buildPhoneWidgetSingle(data) {
    const next = { ...(data || {}), adapterVersion: VERSION };
    return patchPhoneGeneratedHtml(adapter, baseBuilders.buildPhoneWidget.call(adapter, next), next);
  };

  // The sole VIS render owner. main.js creates the four regular views and this
  // same transaction creates iPad Mini from the exact same render model.
  adapter.renderVisFull = async function renderVisFullSingle(force = false) {
    if (adapter.__singleVis600RenderActive) return;
    adapter.__singleVis600RenderActive = true;
    try {
      return await ownerContext.run({ owner: 'single-vis-0.6.0' }, async () => {
        const result = await baseRenderVisFull.call(adapter, force);
        if (!canonicalData) throw new Error('[VIS 0.6.0] render data was not captured');

        const ipadHtml = await buildIpadMini(adapter, canonicalData);
        await rawSetStateAsync('vis.htmlIpadMini', ipadHtml, true);

        await adapter.setObjectNotExistsAsync('status.debug.singleVisOwner600', {
          type: 'state',
          common: { name: 'Single VIS owner 0.6.0', type: 'string', role: 'text', read: true, write: false, def: '' },
          native: {}
        });
        await rawSetStateAsync(
          'status.debug.singleVisOwner600',
          `AKTIV · 1 renderVisFull · 5 VIS-States · legacy VIS writes blocked ${blockedLegacyWrites}x` +
            `${lastBlocked ? ` · last ${lastBlocked}` : ''}`,
          true
        );
        return result;
      });
    } finally {
      adapter.__singleVis600RenderActive = false;
    }
  };

  // forceImmediateRender from the original class ultimately calls this.renderVis,
  // which now reaches the single render owner above.
  if (baseForceImmediateRender) {
    adapter.forceImmediateRender = function forceImmediateRenderSingle(...args) {
      return baseForceImmediateRender.apply(adapter, args);
    };
  }

  return adapter;
}

function createAdapter(options = {}) {
  return install(createLegacyRuntime(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

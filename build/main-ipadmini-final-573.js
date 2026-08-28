'use strict';

// 0.5.73: Phone-VIS ohne aktive 0.5.70/0.5.71/0.5.72-Nachschreibkette.
// Basis ist der stabile 0.5.68-Pfad. Die 24h-Pooltemperaturkurve wird direkt
// aus dem vom Vollrender gelieferten poolTempSparklineSvg in die Phone-Builder
// eingesetzt. Gesamtgroesse bleibt unveraendert.
const createBase = require('./main-ipadmini-final-568.js');
const VERSION = 'v0.5.73';
const PHONE_IDS = new Set(['vis.htmlPhone', 'vis.widgetPhone']);

function patchVersion(v) {
  return String(v || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function cleanOld(html) {
  let out = String(html || '');
  out = out.replace(/<style data-phone-temp-(?:568|569|570|571|572|573)="1">[\s\S]*?<\/style>/g, '');
  out = out.replace(/<div class="(?:temp-inline-(?:568|569|570)|ps-temp-inline-(?:571|572)|phone-temp-inline-(?:572|573))">[\s\S]*?<\/div>/g, '');
  return out;
}

function patchPhone(html, svg) {
  let out = patchVersion(cleanOld(html));
  const curve = String(svg || '').trim();
  if (!out || !curve.includes('<svg')) return out;

  const css = '<style data-phone-temp-573="1">.phone-temp-inline-573{position:relative;height:32px;flex:1 1 auto;min-width:90px;max-width:175px;margin-left:14px;overflow:hidden;color:#76d7ff;align-self:center;pointer-events:none}.phone-temp-inline-573 svg,.phone-temp-inline-573 .sparkline{display:block!important;width:100%!important;max-width:none!important;height:32px!important;overflow:hidden!important}.phone-temp-inline-573 path{fill:none!important;stroke:#76d7ff!important;stroke-width:1!important;stroke-linecap:round!important;stroke-linejoin:round!important}.phone-temp-inline-573 circle{fill:#76d7ff!important;stroke:none!important}</style>';
  if (out.includes('</head>')) out = out.replace('</head>', css + '</head>');
  else out = css + out;

  let inserted = false;
  out = out.replace(
    /(<div class="temp-row">\s*<div class="temp">[\s\S]*?<\/div>\s*<div class="unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
    (_m, a, b) => { inserted = true; return `${a}<div class="phone-temp-inline-573">${curve}</div>${b}`; }
  );
  if (!inserted) {
    out = out.replace(
      /(<div class="ps-tempRow">\s*<div class="ps-temp">[\s\S]*?<\/div>\s*<div class="ps-unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
      (_m, a, b) => `${a}<div class="phone-temp-inline-573">${curve}</div>${b}`
    );
  }
  return out;
}

function install(adapter) {
  if (!adapter || adapter.__phone573Installed) return adapter;
  adapter.__phone573Installed = true;
  adapter.__phone573SvgSeen = false;

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const d = { ...(data || {}), adapterVersion: VERSION };
      const svg = String(d.poolTempSparklineSvg || '');
      if (svg.includes('<svg')) adapter.__phone573SvgSeen = true;
      return patchPhone(original(d), svg);
    };
  }

  // Letzter Writer fuer Phone-States: Version 0.5.73 bleibt definitiv erhalten.
  // Es gibt in dieser Vererbung keine 0.5.70-Nachschreibschicht mehr.
  const previousSetStateIfChanged = typeof adapter.setStateIfChanged === 'function'
    ? adapter.setStateIfChanged.bind(adapter)
    : null;
  adapter.setStateIfChanged = async function(id, value, ack = true, ...rest) {
    if (PHONE_IDS.has(String(id)) && typeof value === 'string') {
      const next = patchVersion(value);
      const cur = await adapter.getStateAsync(id);
      if (cur && cur.val === next) return false;
      await adapter.setStateAsync(id, next, ack);
      return true;
    }
    return previousSetStateIfChanged
      ? previousSetStateIfChanged(id, value, ack, ...rest)
      : adapter.setStateAsync(id, value, ack);
  };

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(h); } catch {}
      if (adapter.isShuttingDown) return;
      try {
        await adapter.setObjectNotExistsAsync('status.debug.phoneTemp573', {
          type:'state', common:{name:'Phone 24h Temperaturkurve 0.5.73',type:'string',role:'text',read:true,write:false,def:''}, native:{}
        });
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.renderVisFull === 'function') await adapter.renderVisFull(true);
        await adapter.setStateAsync('status.debug.phoneTemp573', adapter.__phone573SvgSeen ? 'SVG im Phone-Builder vorhanden' : 'Kein poolTempSparklineSvg im Phone-Builder', true);
      } catch {}
    }, 1800));
  });
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

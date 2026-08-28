'use strict';

// 0.5.72: Phone-Temperaturkurve direkt im Phone-Builder einsetzen.
// Der Vollrender liefert poolTempSparklineSvg bereits zusammen mit pH/ORP.
// Keine zweite History-Abfrage, keine nachtraegliche DOM-Manipulation,
// keine Aenderung an Breite/Hoehe der Phone-VIS.
const createBase = require('./main-ipadmini-final-570.js');
const VERSION = 'v0.5.72';
const PHONE_IDS = new Set(['vis.htmlPhone', 'vis.widgetPhone']);

function patchVersion(v) {
  return String(v || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function cleanOldPhoneTempPatches(html) {
  let out = String(html || '');
  out = out.replace(/<style data-phone-temp-(?:568|569|570|571|572)="1">[\s\S]*?<\/style>/g, '');
  out = out.replace(/<div class="(?:temp-inline-(?:568|569|570)|ps-temp-inline-(?:571|572))">[\s\S]*?<\/div>/g, '');
  return out;
}

function patchPhone(html, svg) {
  let out = patchVersion(cleanOldPhoneTempPatches(html));
  const curve = String(svg || '').trim();
  if (!out || !curve) return out;

  const css = '<style data-phone-temp-572="1">.phone-temp-inline-572{position:relative;height:32px;flex:1 1 auto;min-width:90px;max-width:175px;margin-left:14px;overflow:hidden;color:#76d7ff;align-self:center;pointer-events:none}.phone-temp-inline-572 svg,.phone-temp-inline-572 .sparkline{display:block!important;width:100%!important;max-width:none!important;height:32px!important;overflow:hidden!important}.phone-temp-inline-572 path{fill:none!important;stroke:#76d7ff!important;stroke-width:1!important;stroke-linecap:round!important;stroke-linejoin:round!important}.phone-temp-inline-572 circle{fill:#76d7ff!important;stroke:none!important}</style>';
  if (out.includes('</head>')) out = out.replace('</head>', css + '</head>');
  else out = css + out;

  let inserted = false;

  // Aktueller Phone-HTML-Builder.
  out = out.replace(
    /(<div class="temp-row">\s*<div class="temp">[\s\S]*?<\/div>\s*<div class="unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
    (_m, a, b) => {
      inserted = true;
      return `${a}<div class="phone-temp-inline-572">${curve}</div>${b}`;
    }
  );

  // Widget-Variante, falls dort die ps-Klassen verwendet werden.
  if (!inserted) {
    out = out.replace(
      /(<div class="ps-tempRow">\s*<div class="ps-temp">[\s\S]*?<\/div>\s*<div class="ps-unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
      (_m, a, b) => {
        inserted = true;
        return `${a}<div class="phone-temp-inline-572">${curve}</div>${b}`;
      }
    );
  }

  return out;
}

function install(adapter) {
  if (!adapter || adapter.__phone572Installed) return adapter;
  adapter.__phone572Installed = true;
  adapter.__phone572SvgSeen = false;

  // Entscheidend: direkt die Builder-Ausgabe patchen, solange das vom Vollrender
  // gelieferte poolTempSparklineSvg sicher verfuegbar ist.
  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const d = { ...(data || {}), adapterVersion: VERSION };
      const svg = String(d.poolTempSparklineSvg || '');
      if (svg.includes('<svg')) adapter.__phone572SvgSeen = true;
      return patchPhone(original(d), svg);
    };
  }

  // Den alten v0.5.51-String-Writer fuer die Phone-States weiterhin umgehen.
  const previousSetStateIfChanged = typeof adapter.setStateIfChanged === 'function'
    ? adapter.setStateIfChanged.bind(adapter)
    : null;

  adapter.setStateIfChanged = async function setStateIfChanged572(id, value, ack = true, ...rest) {
    if (PHONE_IDS.has(String(id)) && typeof value === 'string') {
      const next = patchVersion(value);
      const cur = await adapter.getStateAsync(id);
      if (cur && cur.val === next) return false;
      await adapter.setStateAsync(id, next, ack);
      return true;
    }
    if (previousSetStateIfChanged) return previousSetStateIfChanged(id, value, ack, ...rest);
    await adapter.setStateAsync(id, value, ack);
    return true;
  };

  // Diagnose nur als State; keine Warnspam-Logs.
  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(h); } catch {}
      if (adapter.isShuttingDown) return;
      try {
        await adapter.setObjectNotExistsAsync('status.debug.phoneTemp572', {
          type:'state', common:{name:'Phone 24h Temperaturkurve 0.5.72',type:'string',role:'text',read:true,write:false,def:''}, native:{}
        });
        await adapter.setStateAsync('status.debug.phoneTemp572', adapter.__phone572SvgSeen ? 'SVG im Phone-Builder vorhanden' : 'Kein poolTempSparklineSvg im Phone-Builder', true);
      } catch {}
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.renderVisFull === 'function') await adapter.renderVisFull(true);
      } catch {}
      try {
        await adapter.setStateAsync('status.debug.phoneTemp572', adapter.__phone572SvgSeen ? 'SVG im Phone-Builder vorhanden' : 'Kein poolTempSparklineSvg im Phone-Builder', true);
      } catch {}
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

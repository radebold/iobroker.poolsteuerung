'use strict';

// 0.5.68: gezielte Phone-VIS-Anpassung auf stabilem 0.5.67-Pfad.
// Keine Runtime-DOM-Manipulation, keine Aenderung an Gesamtbreite/-hoehe.
// - PH-Info im vorhandenen Hero rechts ausrichten.
// - vorhandene 24h-Pooltemperatur-Sparkline direkt in die Temperaturzeile setzen.
const createBase = require('./main-ipadmini-final-567.js');
const VERSION = 'v0.5.68';

function addClassToTag(tag, cls) {
  if (!tag || tag.includes(cls)) return tag;
  if (/\bclass\s*=\s*"/.test(tag)) return tag.replace(/\bclass\s*=\s*"([^"]*)"/, (_m, c) => `class="${c} ${cls}"`);
  return tag.replace(/^<([a-zA-Z0-9-]+)/, `<$1 class="${cls}"`);
}

function markPhInfo(html) {
  let out = String(html || '');
  // Der Schalter ist je nach Phone-Variante label oder button. Nur den Container markieren,
  // der den sichtbaren Text PH-Info enthaelt.
  out = out.replace(/<(label|button)\b[^>]*>[\s\S]{0,500}?PH-Info[\s\S]{0,500}?<\/\1>/i, match => {
    const end = match.indexOf('>');
    if (end < 0) return match;
    return addClassToTag(match.slice(0, end + 1), 'ph-info-right-568') + match.slice(end + 1);
  });
  return out;
}

function injectTempSpark(html, svg) {
  let out = String(html || '');
  if (!svg) return out;

  // Normale Phone-HTML-Variante: Temperatur + Einheit liegen in .temp-row.
  out = out.replace(
    /(<div class="temp-row">\s*<div class="temp">[\s\S]*?<\/div>\s*<div class="unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
    `$1<div class="temp-inline-568">${svg}</div>$2`
  );

  // Widget-/PS-Variante.
  out = out.replace(
    /(<div class="ps-tempRow">\s*<div class="ps-temp">[\s\S]*?<\/div>\s*<div class="ps-unit">[\s\S]*?<\/div>)(\s*<\/div>)/i,
    `$1<div class="temp-inline-568">${svg}</div>$2`
  );

  return out;
}

function injectCss(html) {
  let out = String(html || '');
  if (!out || out.includes('data-phone-568="1"')) return out;
  const css = `<style data-phone-568="1">
/* Nur innerhalb vorhandener Flaechen; keine Seiten-/Kartenhoehe aendern. */
.ph-info-right-568{margin-left:auto!important;margin-right:0!important;align-self:flex-end!important;justify-self:end!important}
.temp-inline-568{height:34px;min-width:96px;max-width:150px;flex:1 1 120px;margin-left:auto;overflow:hidden;color:#39aef7;align-self:center;pointer-events:none}
.temp-inline-568 svg,.temp-inline-568 .sparkline{display:block!important;width:100%!important;height:34px!important;max-width:none!important;overflow:hidden!important}
.temp-inline-568 path{stroke-width:1!important}
</style>`;
  return out.includes('</head>') ? out.replace('</head>', css + '</head>') : css + out;
}

function patchPhone(html, data) {
  let out = String(html || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
  out = markPhInfo(out);
  out = injectTempSpark(out, String((data && data.poolTempSparklineSvg) || ''));
  out = injectCss(out);
  return out;
}

function install(adapter) {
  if (!adapter || adapter.__phone568Installed) return adapter;
  adapter.__phone568Installed = true;

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = function buildPhone568(data) {
      const patchedData = { ...(data || {}), adapterVersion: VERSION };
      return patchPhone(original(patchedData), patchedData);
    };
  }
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

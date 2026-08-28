'use strict';

// 0.5.65: Phone-VIS direkt NACH dem fertigen Render patchen.
// - sichtbare Version sicher auf 0.5.65
// - sichtbaren PH-Info-Schalter rein horizontal nach rechts verschieben
// - 24h-Pooltemperaturkurve in die vorhandene Temperaturzeile einsetzen
// WICHTIG: keine zusaetzliche Seitenhoehe und keine Aenderung der Gesamtgroesse.
const createBase = require('./main-ipadmini-final-564.js');
const VERSION = 'v0.5.65';
const PHONE_IDS = ['vis.htmlPhone', 'vis.widgetPhone'];
const LOCAL24H_ID = 'status.trend.ipadMiniLocal24hJson';
const POOL24H_ID = 'status.trend.poolTemp24hJson';

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function normalizeRows(rows) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : [])
    .map(r => ({ ts: Number(r && r.ts), val: num(r && (r.val !== undefined ? r.val : r)) }))
    .filter(r => Number.isFinite(r.ts) && r.val !== null && r.ts >= start && r.ts <= now)
    .sort((a,b) => a.ts - b.ts);
}

function buildTempSvg(rows) {
  let values = normalizeRows(rows);
  if (values.length < 2) return '';
  if (values.length > 96) {
    const sampled = [];
    for (let i = 0; i < 96; i++) sampled.push(values[Math.round(i * (values.length - 1) / 95)]);
    values = sampled;
  }
  const nums = values.map(r => r.val);
  const amin = Math.min(...nums), amax = Math.max(...nums);
  const vr = Math.max(0.6, amax - amin);
  const center = (amin + amax) / 2;
  const min = center - vr * 0.62, max = center + vr * 0.62;
  const t0 = values[0].ts, t1 = values[values.length - 1].ts;
  const tr = Math.max(1, t1 - t0), rr = Math.max(0.001, max - min);
  const W = 160, H = 30, px = 2, py = 3;
  const rnd = x => Math.round(x * 10) / 10;
  const X = ts => px + ((ts - t0) / tr) * (W - 2 * px);
  const Y = val => py + (1 - ((val - min) / rr)) * (H - 2 * py);
  const path = values.map((r,i) => `${i ? 'L' : 'M'}${rnd(X(r.ts))} ${rnd(Y(r.val))}`).join(' ');
  const last = values[values.length - 1];
  return `<svg class="phone-temp24-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="${rnd(X(last.ts))}" cy="${rnd(Y(last.val))}" r="1.6" fill="currentColor"></circle></svg>`;
}

function patchVersion(html) {
  return String(html || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function injectPhoneRuntime(html, svg) {
  let out = patchVersion(html);
  if (!out) return out;
  out = out.replace(/<style data-phone-direct-565="1">[\s\S]*?<\/style>/g, '');
  out = out.replace(/<script data-phone-direct-565="1">[\s\S]*?<\/script>/g, '');

  const css = `<style data-phone-direct-565="1">
/* Alles bleibt innerhalb der vorhandenen Hero-Hoehe. */
.phone-temp24-inline{height:30px;min-width:92px;max-width:150px;flex:1 1 120px;margin-left:10px;align-self:center;position:relative;overflow:hidden;color:#39aef7;pointer-events:none}
.phone-temp24-inline .phone-temp24-svg{display:block;width:100%!important;height:30px!important;overflow:hidden}
.phone-temp24-inline:after{content:'24h';position:absolute;right:1px;bottom:0;font-size:7px;line-height:1;color:#b6cce3;font-weight:700}
</style>`;

  const safeSvg = JSON.stringify(String(svg || ''));
  const script = `<script data-phone-direct-565="1">
(function(){
  function run(){
    try{
      var hero=document.querySelector('.hero,.ps-hero');
      if(!hero)return;

      /* PH-Info anhand des sichtbaren Textes finden. Nur horizontal verschieben. */
      var all=[].slice.call(hero.querySelectorAll('button,label,div,span'));
      var textNode=all.find(function(el){return (el.textContent||'').replace(/\\s+/g,' ').trim()==='PH-Info';});
      var ph=textNode && (textNode.closest('button,label') || textNode);
      if(ph){
        var hr=hero.getBoundingClientRect(), pr=ph.getBoundingClientRect();
        var dx=(hr.right-14)-pr.right;
        if(Math.abs(dx)>1){
          ph.style.transform='translateX('+Math.round(dx)+'px)';
          ph.style.transformOrigin='center center';
        }
      }

      /* Kurve in die bereits vorhandene Temperaturzeile setzen. */
      var row=hero.querySelector('.temp-row,.ps-tempRow');
      if(row && !row.querySelector('.phone-temp24-inline')){
        var svg=${safeSvg};
        if(svg){
          var box=document.createElement('div');
          box.className='phone-temp24-inline';
          box.innerHTML=svg;
          row.appendChild(box);
        }
      }
    }catch(e){}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
  setTimeout(run,250);
})();
</script>`;

  if (out.includes('</head>')) out = out.replace('</head>', css + '</head>');
  else out = css + out;
  if (out.includes('</body>')) out = out.replace('</body>', script + '</body>');
  else out += script;
  return out;
}

function install(adapter) {
  if (!adapter || adapter.__phoneDirect565Installed) return adapter;
  adapter.__phoneDirect565Installed = true;
  let currentSvg = '';

  async function refreshSvg() {
    let rows = [];
    try {
      const s = await adapter.getStateAsync(LOCAL24H_ID);
      const obj = parseJson(s && s.val, {});
      if (obj && Array.isArray(obj.water)) rows = obj.water;
    } catch {}
    if (normalizeRows(rows).length < 2) {
      try {
        const s = await adapter.getStateAsync(POOL24H_ID);
        const arr = parseJson(s && s.val, []);
        if (Array.isArray(arr)) rows = arr;
      } catch {}
    }
    try {
      const id = String((adapter.config && adapter.config.waterTempStateId) || '').trim();
      if (id) {
        const s = await adapter.getForeignStateAsync(id);
        const v = num(s && s.val);
        if (v !== null) rows = [...normalizeRows(rows), { ts: Date.now(), val: v }];
      }
    } catch {}
    currentSvg = buildTempSvg(rows);
    return currentSvg;
  }

  async function patchFinishedPhoneStates() {
    await refreshSvg();
    for (const id of PHONE_IDS) {
      try {
        const s = await adapter.getStateAsync(id);
        const cur = String((s && s.val) || '');
        if (!cur) continue;
        const next = injectPhoneRuntime(cur, currentSvg);
        if (next !== cur) await adapter.setStateAsync(id, next, true);
      } catch (e) {
        if (adapter.config && adapter.config.debugMode && adapter.log) adapter.log.debug(`[PHONE 0.5.65] ${id}: ${e.message || e}`);
      }
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const original = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFull565(...args) {
      const result = await original(...args);
      await patchFinishedPhoneStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(h); } catch {}
      if (adapter.isShuttingDown) return;
      await patchFinishedPhoneStates();
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

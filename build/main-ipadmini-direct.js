'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.37';
const STATE_ID = 'vis.htmlIpadMini';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function fmt(value, digits) {
  const parsed = num(value);
  return parsed === null ? '--' : parsed.toFixed(digits).replace('.', ',');
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'yes', 'ja', 'active', 'aktiv'].includes(String(value ?? '').trim().toLowerCase());
}

function rows(values, current, maxPoints = 64) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  let result = (Array.isArray(values) ? values : [])
    .map(row => ({ ts: Number(row && row.ts), val: num(row && row.val) }))
    .filter(row => Number.isFinite(row.ts) && row.val !== null && row.ts >= start && row.ts <= now)
    .sort((a, b) => a.ts - b.ts);
  const currentNum = num(current);
  if (currentNum !== null && (!result.length || now - result[result.length - 1].ts > 15000)) {
    result.push({ ts: now, val: currentNum });
  }
  if (!result.length && currentNum !== null) result = [{ ts: start, val: currentNum }, { ts: now, val: currentNum }];
  if (result.length === 1) result.unshift({ ts: Math.max(start, result[0].ts - 3600000), val: result[0].val });
  if (result.length > maxPoints) {
    const compact = [];
    for (let i = 0; i < maxPoints; i++) compact.push(result[Math.round(i * (result.length - 1) / (maxPoints - 1))]);
    result = compact;
  }
  return result;
}

function chart(values, current, color, digits, minRange, unit = '') {
  const data = rows(values, current);
  if (data.length < 2) return { svg: '<div class="empty">Noch keine Verlaufsdaten</div>', min: '--', max: '--' };
  const numbers = data.map(row => row.val);
  const actualMin = Math.min(...numbers);
  const actualMax = Math.max(...numbers);
  const range = Math.max(actualMax - actualMin, minRange);
  const center = (actualMin + actualMax) / 2;
  const minY = center - range * 0.62;
  const maxY = center + range * 0.62;
  const first = data[0].ts;
  const last = data[data.length - 1].ts;
  const timeRange = Math.max(1, last - first);
  const valueRange = Math.max(0.0001, maxY - minY);
  const point = row => {
    const x = Math.round((((row.ts - first) / timeRange) * 454 + 3) * 10) / 10;
    const y = Math.round((8 + (1 - ((row.val - minY) / valueRange)) * 87) * 10) / 10;
    return { x, y };
  };
  const path = data.map((row, index) => {
    const p = point(row);
    return `${index ? 'L' : 'M'}${p.x} ${p.y}`;
  }).join(' ');
  const end = point(data[data.length - 1]);
  return {
    svg: `<svg viewBox="0 0 460 105" preserveAspectRatio="none"><path class="grid" d="M0 27H460M0 53H460M0 79H460"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${end.x}" cy="${end.y}" r="3" fill="${color}"/></svg>`,
    min: `${fmt(actualMin, digits)}${unit}`,
    max: `${fmt(actualMax, digits)}${unit}`
  };
}

function trendClass(value) {
  return value === '↑' ? 'up' : value === '↓' ? 'down' : 'flat';
}

function canister(data) {
  const info = data.phCanister || {};
  const level = num(info.levelL);
  const percent = num(info.percent);
  if (level === null) return { text: 'nicht verfügbar', sub: '', cls: 'bad' };
  return {
    text: `${info.scaleEnabled === true ? '≈ ' : ''}${fmt(level, 2)} l`,
    sub: `${info.scaleEnabled === true ? `${fmt(level, 3)} kg` : ''}${percent === null ? '' : `${info.scaleEnabled === true ? ' · ' : ''}${fmt(percent, 0)} %`}`,
    cls: info.critical ? 'bad' : info.warn ? 'warn' : 'good'
  };
}

function schedule(text) {
  const list = String(text || '--').split(/\n+/).map(value => value.trim()).filter(Boolean).slice(0, 3);
  if (!list.length || list[0] === '--') return '<span class="schedule-empty">Keine kommenden Schaltungen</span>';
  return list.map(value => `<span class="schedule-chip">${esc(value)}</span>`).join('');
}

function buildHtml(data, history, namespace) {
  const pumpOn = bool(data.pumpOn);
  const phPumpOn = bool(data.phPumpOn);
  const chlorOn = bool(data.chlorOn);
  const heatpumpOn = bool(data.heatpumpOn);
  const heatMode = String(data.heatpumpMode ?? '').toLowerCase();
  const heating = heatpumpOn && /(heiz|heat|warm)/.test(heatMode);
  const fan = num(data.heatpumpFanPercent);
  const can = canister(data);
  const cards = [
    { key: 'outside', label: 'Außentemperatur', value: data.outsideTemp, digits: 1, unit: ' °C', color: '#58baff', trend: data.outsideTempTrend, range: 1 },
    { key: 'water', label: 'Wassertemperatur', value: data.poolTemp, digits: 1, unit: ' °C', color: '#60ddd9', trend: data.poolTempTrend, range: 1 },
    { key: 'ph', label: 'pH-Wert', value: data.ph, digits: 2, unit: '', color: data.phInRange ? '#67df7e' : '#ffbd59', trend: data.phTrend, range: .1 },
    { key: 'orp', label: 'ORP-Wert', value: data.orp, digits: 0, unit: ' mV', color: data.orpInRange ? '#67df7e' : '#ff9f59', trend: data.orpTrend, range: 30 }
  ];
  const icons = { outside: '☀', water: '◉', ph: '⚗', orp: 'ϟ' };
  const cardHtml = cards.map(card => {
    const graph = chart(history[card.key] || [], card.value, card.color, card.digits, card.range, card.unit);
    const phExtras = card.key === 'ph' ? `<div class="can ${can.cls}"><b>pH-Minus ${esc(can.text)}</b><small>${esc(can.sub)}</small></div><div class="device ${phPumpOn ? 'on' : ''}"><i></i>Dosierpumpe ${phPumpOn ? 'EIN' : 'AUS'}</div><div class="dose"><button data-dose="60">60 s</button><button data-dose="120">120 s</button><button data-dose="180">180 s</button></div>` : '';
    const orpExtra = card.key === 'orp' ? `<div class="device ${chlorOn ? 'on' : ''}"><i></i>Chlorinator ${chlorOn ? 'EIN' : 'AUS'}</div>` : '';
    return `<section class="card" style="--a:${card.color}"><div class="card-head"><span class="icon">${icons[card.key]}</span><b>${esc(card.label)}</b>${card.key === 'ph' ? '' : '<small>24 Stunden</small>'}</div>${phExtras}${orpExtra}<div class="reading"><strong>${esc(fmt(card.value, card.digits))}</strong>${card.unit ? `<em>${esc(card.unit.trim())}</em>` : ''}<span class="trend ${trendClass(card.trend)}">${esc(card.trend || '→')}</span></div><div class="history">${graph.svg}</div><div class="minmax"><span>Min ${esc(graph.min)}</span><span>Max ${esc(graph.max)}</span></div></section>`;
  }).join('');
  const ns = JSON.stringify(String(namespace || 'poolsteuerung.0'));
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><style>:root{--bg:#06111e;--line:rgba(255,255,255,.1);--txt:#f6fbff;--muted:#9bb0c8}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg)}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--txt)}.screen{width:100vw;height:100vh;padding:10px 12px;display:grid;grid-template-rows:34px minmax(0,1fr) 42px 42px;gap:8px;background:radial-gradient(circle at 10% -10%,rgba(53,145,230,.2),transparent 35%),linear-gradient(145deg,#06101c,#0a1a2c 58%,#07131f)}header{display:flex;align-items:center;justify-content:space-between;padding:0 4px}.brand{display:flex;align-items:center;gap:9px}.drop{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(145deg,#228bd8,#28c8c0);font-size:18px}.title{font-size:21px;font-weight:900;letter-spacing:.08em}.sub{font-size:9px;color:var(--muted);font-weight:700;letter-spacing:.11em}.pump{display:inline-flex;align-items:center;gap:7px;margin-left:10px;padding:4px 9px;border:1px solid var(--line);border-radius:999px;font-size:9px;font-weight:900}.pump i,.device i{width:12px;height:12px;border-radius:50%;background:#ff625b;box-shadow:0 0 10px rgba(255,98,91,.55)}.pump.on i,.device.on i{background:#63e07b;box-shadow:0 0 12px rgba(99,224,123,.65)}.meta{text-align:right;font-size:9px;color:var(--muted);line-height:1.25}.cards{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:8px;min-height:0}.card{position:relative;min-width:0;min-height:0;overflow:hidden;border:1px solid var(--line);border-radius:17px;padding:12px 15px 9px;background:linear-gradient(150deg,rgba(17,40,65,.98),rgba(8,24,41,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 9px 22px rgba(0,0,0,.18)}.card:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--a)}.card-head{height:30px;display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:8px}.card-head .icon{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.08);color:var(--a);font-size:17px}.card-head b{font-size:17px}.card-head small{font-size:9px;color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:.06em}.reading{height:88px;display:flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap}.reading strong{font-size:78px;font-weight:900;line-height:.88;letter-spacing:-.055em;color:var(--a);font-variant-numeric:tabular-nums}.reading em{font-style:normal;font-size:27px;font-weight:850;color:rgba(247,251,255,.8)}.trend{font-size:31px;font-weight:900}.trend.up{color:#67df7e}.trend.down{color:#ffbd59}.trend.flat{color:#afbed0}.history{height:100px;border-radius:10px;overflow:hidden;background:rgba(3,14,25,.3)}.history svg{width:100%;height:100%;display:block}.grid{fill:none;stroke:rgba(255,255,255,.07);stroke-width:1}.empty{height:100%;display:grid;place-items:center;color:var(--muted);font-size:12px}.minmax{height:20px;display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:10px;font-weight:750;padding-top:4px}.can{position:absolute;right:15px;top:13px;z-index:3;min-width:140px;height:31px;padding:3px 8px;border:1px solid rgba(255,255,255,.13);border-radius:9px;background:rgba(4,17,30,.78);text-align:right}.can b,.can small{display:block}.can b{font-size:9px}.can small{font-size:7px;color:var(--muted)}.can.good b{color:#7cea91}.can.warn b{color:#ffd06e}.can.bad b{color:#ff756d}.device{position:absolute;right:15px;top:126px;z-index:4;display:flex;align-items:center;gap:5px;height:22px;padding:3px 8px;border:1px solid rgba(255,255,255,.11);border-radius:999px;background:rgba(4,17,30,.82);font-size:8px;font-weight:900;color:#aab9c8}.device i{width:10px;height:10px;background:#7c8da0;box-shadow:none}.dose{position:absolute;left:15px;top:126px;z-index:5;display:flex;gap:5px}.dose button{height:23px;min-width:49px;padding:2px 8px;border:1px solid rgba(105,196,255,.4);border-radius:999px;background:linear-gradient(145deg,#298bd0,#174c7e);color:#fff;font:900 8px Arial;cursor:pointer}.dose button:disabled{opacity:.6}.heat{border:1px solid var(--line);border-radius:13px;background:rgba(10,28,47,.96);display:grid;grid-template-columns:1.3fr repeat(3,1fr);align-items:center;gap:5px;padding:5px 10px}.heat>div{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 9px;border-left:1px solid rgba(255,255,255,.07);font-size:10px;color:var(--muted)}.heat>div:first-child{border-left:0;color:#eaf4ff;font-size:12px;font-weight:900}.heat b{font-size:12px;color:#dbe9f6}.heat b.on{color:#67df7e}.schedule{border:1px solid var(--line);border-radius:13px;background:rgba(10,28,47,.96);display:grid;grid-template-columns:auto 1fr;align-items:center;gap:10px;padding:6px 10px;overflow:hidden}.schedule-label{font-size:10px;color:var(--muted);font-weight:900;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}.schedule-list{display:flex;justify-content:flex-end;gap:6px;overflow:hidden}.schedule-chip{max-width:31%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(84,200,255,.17);background:rgba(84,200,255,.09);border-radius:999px;padding:5px 8px;font-size:9px;color:#deedff;font-weight:750}.schedule-empty{font-size:10px;color:var(--muted)}@media(max-width:900px){.reading strong{font-size:68px}.card-head b{font-size:15px}.history{height:90px}.dose{top:116px}.device{top:116px}}</style></head><body><main class="screen"><header><div class="brand"><span class="drop">◉</span><div><div><span class="title">POOL</span><span class="pump ${pumpOn ? 'on' : ''}"><i></i>Umwälzpumpe ${pumpOn ? 'EIN' : 'AUS'}</span></div><div class="sub">24H LIVE-VERLAUF</div></div></div><div class="meta"><div>${esc(data.updated || '--')}</div><div>${VERSION} · iPad Mini · 1024 × 768</div></div></header><section class="cards">${cardHtml}</section><section class="heat"><div>↻ Wärmepumpe</div><div><span>LÄUFT</span><b class="${heatpumpOn ? 'on' : ''}">${heatpumpOn ? 'JA' : 'NEIN'}</b></div><div><span>HEIZT</span><b class="${heating ? 'on' : ''}">${heating ? 'JA' : 'NEIN'}</b></div><div><span>DREHZAHL</span><b>${fan === null ? '--' : `${Math.round(fan)} %`}</b></div></section><footer class="schedule"><div class="schedule-label">Nächste Schaltungen</div><div class="schedule-list">${schedule(data.nextActionsText)}</div></footer></main><script>(function(){var n=${ns};function api(){var w=[window];try{w.push(window.parent)}catch(e){}try{w.push(window.top)}catch(e){}for(var i=0;i<w.length;i++)try{if(w[i]&&w[i].vis)return w[i].vis}catch(e){}return null}async function set(id,v){var a=api();if(!a)return false;try{if(typeof a.setValue==='function'){var r=a.setValue(id,v);if(r&&r.then)await r;return true}}catch(e){}try{if(a.conn&&typeof a.conn.setState==='function'){var q=a.conn.setState(id,v);if(q&&q.then)await q;return true}}catch(e){}return false}document.addEventListener('click',async function(e){var b=e.target&&e.target.closest?e.target.closest('button[data-dose]'):null;if(!b||b.disabled)return;e.preventDefault();var t=b.textContent,s=Number(b.dataset.dose)||30;b.disabled=true;b.textContent='…';var ok=await set(n+'.control.ph.manualDoseSec',s);if(ok)ok=await set(n+'.control.ph.manualTrigger',Date.now());b.textContent=ok?'OK':'Fehler';setTimeout(function(){b.textContent=t;b.disabled=false},1200)},true)})();</script></body></html>`;
}

function install(adapter) {
  if (!adapter || adapter.__ipadMiniDirectInstalled) return adapter;
  adapter.__ipadMiniDirectInstalled = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => String(original({ ...(data || {}), adapterVersion: VERSION })).replace(/v0\.4\.\d+/g, VERSION);
  }

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    const data = adapter.__readableIpadMiniData;
    if (data) {
      const html = buildHtml(data, adapter.__readableIpadMiniHistory || {}, adapter.namespace);
      await adapter.setStateIfChanged(STATE_ID, html, true);
      if (!adapter.__ipadMiniDirectLogged) {
        adapter.__ipadMiniDirectLogged = true;
        adapter.log.info(`[IPAD-MINI] ${VERSION}: kompakte Direktansicht mit 60/120/180-Sekunden-Dosierung aktiv (${Buffer.byteLength(html, 'utf8')} Bytes)`);
      }
    }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [900, 4000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          if (delay === 900) await adapter.setStateAsync(STATE_ID, '', true);
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
          await adapter.forceImmediateRender();
        } catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Direktansicht konnte nicht erzeugt werden: ' + (error.message || error));
        }
      }, delay));
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

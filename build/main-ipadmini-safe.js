'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.38';
const STATE_ID = 'vis.htmlIpadMini';
const MAX_BYTES = 30000;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function fmt(value, digits = 1) {
  const parsed = num(value);
  return parsed === null ? '--' : parsed.toFixed(digits).replace('.', ',');
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'yes', 'ja', 'active', 'aktiv'].includes(String(value ?? '').trim().toLowerCase());
}

function normalizeRows(values, current, maxPoints = 32) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  let rows = (Array.isArray(values) ? values : [])
    .map(row => ({ ts: Number(row && row.ts), val: num(row && (row.val !== undefined ? row.val : row)) }))
    .filter(row => Number.isFinite(row.ts) && row.val !== null && row.ts >= start && row.ts <= now)
    .sort((a, b) => a.ts - b.ts);

  const currentNum = num(current);
  if (currentNum !== null && (!rows.length || now - rows[rows.length - 1].ts > 15000)) {
    rows.push({ ts: now, val: currentNum });
  }
  if (!rows.length && currentNum !== null) rows = [{ ts: start, val: currentNum }, { ts: now, val: currentNum }];
  if (rows.length === 1) rows.unshift({ ts: Math.max(start, rows[0].ts - 3600000), val: rows[0].val });

  if (rows.length > maxPoints) {
    const compact = [];
    for (let index = 0; index < maxPoints; index++) {
      compact.push(rows[Math.round(index * (rows.length - 1) / (maxPoints - 1))]);
    }
    rows = compact;
  }
  return rows;
}

function chart(values, current, color, digits, minRange, unit = '') {
  const rows = normalizeRows(values, current);
  if (rows.length < 2) return { svg: '<div class="empty">Noch keine Verlaufsdaten</div>', min: '--', max: '--' };

  const nums = rows.map(row => row.val);
  const actualMin = Math.min(...nums);
  const actualMax = Math.max(...nums);
  const range = Math.max(actualMax - actualMin, minRange);
  const center = (actualMin + actualMax) / 2;
  const minY = center - range * 0.62;
  const maxY = center + range * 0.62;
  const first = rows[0].ts;
  const last = rows[rows.length - 1].ts;
  const timeRange = Math.max(1, last - first);
  const valueRange = Math.max(0.0001, maxY - minY);
  const point = row => ({
    x: Math.round((3 + ((row.ts - first) / timeRange) * 454) * 10) / 10,
    y: Math.round((8 + (1 - ((row.val - minY) / valueRange)) * 87) * 10) / 10
  });
  const path = rows.map((row, index) => {
    const p = point(row);
    return `${index ? 'L' : 'M'}${p.x} ${p.y}`;
  }).join(' ');
  const end = point(rows[rows.length - 1]);
  return {
    svg: `<svg viewBox="0 0 460 105" preserveAspectRatio="none"><path class="grid" d="M0 27H460M0 53H460M0 79H460"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${end.x}" cy="${end.y}" r="3" fill="${color}"/></svg>`,
    min: `${fmt(actualMin, digits)}${unit}`,
    max: `${fmt(actualMax, digits)}${unit}`
  };
}

function trendClass(value) {
  return value === '↑' ? 'up' : value === '↓' ? 'down' : 'flat';
}

function scheduleHtml(text) {
  const list = String(text || '--').split(/\n+/).map(value => value.trim()).filter(Boolean).slice(0, 3);
  if (!list.length || list[0] === '--') return '<span class="schedule-empty">Keine kommenden Schaltungen</span>';
  return list.map(value => `<span class="schedule-chip">${esc(value)}</span>`).join('');
}

function canisterHtml(data) {
  const info = data.phCanister || {};
  const level = num(info.levelL);
  const percent = num(info.percent);
  const weight = num(info.netKg !== undefined ? info.netKg : info.weightKg);
  const cls = info.critical ? 'bad' : info.warn ? 'warn' : 'good';
  if (level === null) return '<div class="can bad"><b>pH-Minus --</b><small>nicht verfügbar</small></div>';
  const parts = [];
  if (weight !== null) parts.push(`${fmt(weight, 3)} kg`);
  if (percent !== null) parts.push(`${fmt(percent, 0)} %`);
  return `<div class="can ${cls}"><b>pH-Minus ${info.scaleEnabled === true ? '≈ ' : ''}${fmt(level, 2)} l</b><small>${esc(parts.join(' · '))}</small></div>`;
}

function buildHtml(data, history, namespace) {
  const pumpOn = bool(data.pumpOn);
  const phPumpOn = bool(data.phPumpOn);
  const chlorOn = bool(data.chlorOn);
  const heatpumpOn = bool(data.heatpumpOn);
  const heatMode = String(data.heatpumpMode ?? '').toLowerCase();
  const heating = heatpumpOn && /(heiz|heat|warm)/.test(heatMode);
  const fan = num(data.heatpumpFanPercent);
  const cards = [
    { key: 'outside', label: 'Außentemperatur', value: data.outsideTemp, digits: 1, unit: ' °C', color: '#58baff', trend: data.outsideTempTrend, range: 1, icon: '☀' },
    { key: 'water', label: 'Wassertemperatur', value: data.poolTemp, digits: 1, unit: ' °C', color: '#60ddd9', trend: data.poolTempTrend, range: 1, icon: '◉' },
    { key: 'ph', label: 'pH-Wert', value: data.ph, digits: 2, unit: '', color: data.phInRange ? '#67df7e' : '#ffbd59', trend: data.phTrend, range: 0.1, icon: '⚗' },
    { key: 'orp', label: 'ORP-Wert', value: data.orp, digits: 0, unit: ' mV', color: data.orpInRange ? '#67df7e' : '#ff9f59', trend: data.orpTrend, range: 30, icon: 'ϟ' }
  ];

  const cardsHtml = cards.map(card => {
    const graph = chart(history[card.key] || [], card.value, card.color, card.digits, card.range, card.unit);
    let extras = '';
    if (card.key === 'ph') {
      extras = `${canisterHtml(data)}<div class="device ${phPumpOn ? 'on' : ''}"><i></i>Dosierpumpe ${phPumpOn ? 'EIN' : 'AUS'}</div><div class="tools"><div class="dose"><button data-dose="60">60 s</button><button data-dose="120">120 s</button><button data-dose="180">180 s</button></div><div class="cal"><input id="poollab" inputmode="decimal" placeholder="PoolLab z. B. 7,18"><button id="savePh">Speichern</button></div></div>`;
    } else if (card.key === 'orp') {
      extras = `<div class="device ${chlorOn ? 'on' : ''}"><i></i>Chlorinator ${chlorOn ? 'EIN' : 'AUS'}</div>`;
    }
    return `<section class="card" style="--a:${card.color}"><div class="card-head"><span class="icon">${card.icon}</span><b>${esc(card.label)}</b>${card.key === 'ph' ? '' : '<small>24 Stunden</small>'}</div>${extras}<div class="reading"><strong>${esc(fmt(card.value, card.digits))}</strong>${card.unit ? `<em>${esc(card.unit.trim())}</em>` : ''}<span class="trend ${trendClass(card.trend)}">${esc(card.trend || '→')}</span></div><div class="history">${graph.svg}</div><div class="minmax"><span>Min ${esc(graph.min)}</span><span>Max ${esc(graph.max)}</span></div></section>`;
  }).join('');

  const ns = JSON.stringify(String(namespace || 'poolsteuerung.0'));
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><style>:root{--bg:#06111e;--line:rgba(255,255,255,.1);--txt:#f6fbff;--muted:#9bb0c8}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg)}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--txt)}.screen{width:100vw;height:100vh;padding:8px 10px;display:grid;grid-template-rows:36px minmax(0,1fr) 38px 38px;gap:7px;background:linear-gradient(145deg,#06101c,#0a1a2c 58%,#07131f)}header{display:flex;align-items:center;justify-content:space-between;padding:0 4px}.brand{display:flex;align-items:center;gap:8px}.drop{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(145deg,#228bd8,#28c8c0)}.title{font-size:21px;font-weight:900;letter-spacing:.08em}.sub,.meta{font-size:9px;color:var(--muted);font-weight:700}.meta{text-align:right;line-height:1.25}.pump,.device{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;background:rgba(4,17,30,.82);font-size:8px;font-weight:900}.pump{margin-left:9px;padding:4px 8px}.pump i,.device i{width:10px;height:10px;border-radius:50%;background:#7c8da0}.pump.on i,.device.on i{background:#63e07b;box-shadow:0 0 10px rgba(99,224,123,.65)}.cards{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:7px;min-height:0}.card{position:relative;min-width:0;min-height:0;overflow:hidden;border:1px solid var(--line);border-radius:16px;padding:11px 14px 8px;background:linear-gradient(150deg,rgba(17,40,65,.98),rgba(8,24,41,.98))}.card:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--a)}.card-head{height:28px;display:grid;grid-template-columns:27px 1fr auto;align-items:center;gap:7px}.icon{width:27px;height:27px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.08);color:var(--a)}.card-head b{font-size:16px}.card-head small{font-size:8px;color:var(--muted);font-weight:800;text-transform:uppercase}.reading{height:82px;display:flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap}.reading strong{font-size:74px;font-weight:900;line-height:.88;letter-spacing:-.055em;color:var(--a)}.reading em{font-style:normal;font-size:25px;font-weight:850;color:rgba(247,251,255,.8)}.trend{font-size:29px;font-weight:900}.trend.up{color:#67df7e}.trend.down{color:#ffbd59}.trend.flat{color:#afbed0}.history{height:94px;border-radius:9px;overflow:hidden;background:rgba(3,14,25,.3)}.history svg{width:100%;height:100%;display:block}.grid{fill:none;stroke:rgba(255,255,255,.07);stroke-width:1}.empty{height:100%;display:grid;place-items:center;color:var(--muted);font-size:11px}.minmax{height:18px;display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:9px;font-weight:750}.can{position:absolute;right:14px;top:10px;z-index:4;min-width:130px;padding:3px 7px;border:1px solid var(--line);border-radius:8px;background:rgba(4,17,30,.84);text-align:right}.can b,.can small{display:block}.can b{font-size:8px}.can small{font-size:7px;color:var(--muted)}.can.good b{color:#7cea91}.can.warn b{color:#ffd06e}.can.bad b{color:#ff756d}.device{position:absolute;right:14px;top:112px;z-index:5;height:20px;padding:3px 7px;color:#aab9c8}.tools{position:absolute;left:14px;right:14px;top:109px;z-index:6;display:flex;gap:6px;align-items:center}.dose{display:flex;gap:4px}.dose button,.cal button{height:24px;border:1px solid rgba(105,196,255,.4);border-radius:999px;background:linear-gradient(145deg,#298bd0,#174c7e);color:#fff;font:900 8px Arial;cursor:pointer}.dose button{min-width:43px;padding:2px 6px}.cal{margin-left:auto;display:flex;gap:4px}.cal input{width:112px;height:24px;border:1px solid rgba(105,196,255,.35);border-radius:999px;background:#061522;color:#fff;padding:2px 8px;font-size:9px;font-weight:800;outline:none}.cal button{min-width:57px;padding:2px 7px;background:linear-gradient(145deg,#248d7c,#17685c)}button:disabled{opacity:.6}.heat,.schedule{border:1px solid var(--line);border-radius:12px;background:rgba(10,28,47,.96);align-items:center;padding:5px 9px}.heat{display:grid;grid-template-columns:1.3fr repeat(3,1fr);gap:5px}.heat>div{display:flex;justify-content:space-between;gap:6px;padding:0 8px;border-left:1px solid rgba(255,255,255,.07);font-size:9px;color:var(--muted)}.heat>div:first-child{border-left:0;color:#eaf4ff;font-size:11px;font-weight:900}.heat b{font-size:11px;color:#dbe9f6}.heat b.on{color:#67df7e}.schedule{display:grid;grid-template-columns:auto 1fr;gap:9px;overflow:hidden}.schedule-label{font-size:9px;color:var(--muted);font-weight:900;text-transform:uppercase}.schedule-list{display:flex;justify-content:flex-end;gap:5px;overflow:hidden}.schedule-chip{max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid rgba(84,200,255,.17);background:rgba(84,200,255,.09);border-radius:999px;padding:4px 7px;font-size:8px;color:#deedff;font-weight:750}.schedule-empty{font-size:9px;color:var(--muted)}@media(max-width:900px){.reading strong{font-size:65px}.history{height:86px}.tools{top:103px}.device{top:106px}.cal input{width:96px}}</style></head><body><main class="screen"><header><div class="brand"><span class="drop">◉</span><div><div><span class="title">POOL</span><span class="pump ${pumpOn ? 'on' : ''}"><i></i>Umwälzpumpe ${pumpOn ? 'EIN' : 'AUS'}</span></div><div class="sub">24H LIVE-VERLAUF</div></div></div><div class="meta"><div>${esc(data.updated || '--')}</div><div>${VERSION} · iPad Mini · 1024 × 768</div></div></header><section class="cards">${cardsHtml}</section><section class="heat"><div>↻ Wärmepumpe</div><div><span>LÄUFT</span><b class="${heatpumpOn ? 'on' : ''}">${heatpumpOn ? 'JA' : 'NEIN'}</b></div><div><span>HEIZT</span><b class="${heating ? 'on' : ''}">${heating ? 'JA' : 'NEIN'}</b></div><div><span>DREHZAHL</span><b>${fan === null ? '--' : `${Math.round(fan)} %`}</b></div></section><footer class="schedule"><div class="schedule-label">Nächste Schaltungen</div><div class="schedule-list">${scheduleHtml(data.nextActionsText)}</div></footer></main><script>(function(){var n=${ns};function api(){var w=[window];try{w.push(window.parent)}catch(e){}try{w.push(window.top)}catch(e){}for(var i=0;i<w.length;i++)try{if(w[i]&&w[i].vis)return w[i].vis}catch(e){}return null}async function set(id,v){var a=api();if(!a)return false;try{if(typeof a.setValue==='function'){var r=a.setValue(id,v);if(r&&r.then)await r;return true}}catch(e){}try{if(a.conn&&typeof a.conn.setState==='function'){var q=a.conn.setState(id,v);if(q&&q.then)await q;return true}}catch(e){}return false}async function dose(b){var old=b.textContent,sec=Number(b.dataset.dose)||30;b.disabled=true;b.textContent='…';var ok=await set(n+'.control.ph.manualDoseSec',sec);if(ok)ok=await set(n+'.control.ph.manualTrigger',Date.now());b.textContent=ok?'OK':'Fehler';setTimeout(function(){b.textContent=old;b.disabled=false},1200)}async function save(b){var i=document.getElementById('poollab'),v=Number(String(i.value||'').trim().replace(',','.')),old=b.textContent;if(!Number.isFinite(v)||v<0||v>14){b.textContent='Ungültig';setTimeout(function(){b.textContent=old},1200);return}b.disabled=true;b.textContent='…';var ok=await set(n+'.control.ph.calibration.poollabValue',v);if(ok)ok=await set(n+'.control.ph.calibration.saveTrigger',Date.now());b.textContent=ok?'Gespeichert':'Fehler';if(ok)i.value='';setTimeout(function(){b.textContent=old;b.disabled=false},1400)}document.addEventListener('click',function(e){var d=e.target&&e.target.closest?e.target.closest('button[data-dose]'):null;if(d){e.preventDefault();dose(d);return}if(e.target&&e.target.id==='savePh'){e.preventDefault();save(e.target)}},true)})();</script></body></html>`;
}

function validHtml(html) {
  const value = String(html || '');
  return value.startsWith('<!doctype html>') && value.endsWith('</html>') && value.includes('id="poollab"') && value.includes('data-dose="60"') && Buffer.byteLength(value, 'utf8') <= MAX_BYTES;
}

async function readJson(adapter, id, fallback) {
  try {
    const state = await adapter.getStateAsync(id);
    const parsed = JSON.parse(String((state && state.val) || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function loadHistory(adapter) {
  const local = await readJson(adapter, 'status.trend.ipadMiniLocal24hJson', {});
  const [water, ph, orp] = await Promise.all([
    readJson(adapter, 'status.trend.poolTemp24hJson', []),
    readJson(adapter, 'status.trend.phTodayJson', []),
    readJson(adapter, 'status.trend.orpTodayJson', [])
  ]);
  return {
    outside: Array.isArray(local.outside) ? local.outside : [],
    water: Array.isArray(local.water) && local.water.length ? local.water : water,
    ph: Array.isArray(local.ph) && local.ph.length ? local.ph : ph,
    orp: Array.isArray(local.orp) && local.orp.length ? local.orp : orp
  };
}

function install(adapter) {
  if (!adapter || adapter.__ipadMiniSafeInstalled) return adapter;
  adapter.__ipadMiniSafeInstalled = true;
  adapter.__ipadMiniSafeData = null;

  const originalTablet = typeof adapter.buildTabletHtml === 'function' ? adapter.buildTabletHtml.bind(adapter) : null;
  if (originalTablet) {
    adapter.buildTabletHtml = data => {
      adapter.__ipadMiniSafeData = { ...(data || {}) };
      return String(originalTablet({ ...(data || {}), adapterVersion: VERSION })).replace(/v0\.4\.\d+/g, VERSION);
    };
  }

  for (const name of ['buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => String(original({ ...(data || {}), adapterVersion: VERSION })).replace(/v0\.4\.\d+/g, VERSION);
  }

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    const stableState = await adapter.getStateAsync(STATE_ID);
    const stableHtml = stableState && typeof stableState.val === 'string' ? stableState.val : '';
    const data = adapter.__ipadMiniSafeData;
    if (!data) {
      adapter.log.warn('[IPAD-MINI] Keine Renderdaten verfügbar; stabile Basisansicht bleibt aktiv');
      return result;
    }

    try {
      const history = await loadHistory(adapter);
      const html = buildHtml(data, history, adapter.namespace);
      if (!validHtml(html)) {
        adapter.log.warn(`[IPAD-MINI] Sichere Ansicht verworfen (${Buffer.byteLength(html, 'utf8')} Bytes); stabile Basisansicht bleibt aktiv`);
        return result;
      }
      await adapter.setStateIfChanged(STATE_ID, html, true);
      if (!adapter.__ipadMiniSafeLogged) {
        adapter.__ipadMiniSafeLogged = true;
        adapter.log.info(`[IPAD-MINI] ${VERSION}: vollständige sichere Ansicht mit PoolLab-Korrektur aktiv (${Buffer.byteLength(html, 'utf8')} Bytes)`);
      }
    } catch (error) {
      adapter.log.warn('[IPAD-MINI] Sichere Ansicht fehlgeschlagen; stabile Basisansicht bleibt aktiv: ' + (error.message || error));
      if (stableHtml && stableHtml.includes('</html>')) await adapter.setStateIfChanged(STATE_ID, stableHtml, true);
    }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [1200, 4500]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
          await adapter.forceImmediateRender();
        } catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Wiederherstellung fehlgeschlagen: ' + (error.message || error));
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

'use strict';

const createWeightAdapter = require('./main-weight.js');

const ADAPTER_VERSION = 'v0.4.8';
const IPAD_MINI_STATE = 'vis.htmlIpadMini';
const HISTORY_CACHE_MS = 5 * 60 * 1000;
const RANGE_24H_MS = 24 * 60 * 60 * 1000;
const RANGE_7D_MS = 7 * 24 * 60 * 60 * 1000;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function numberValue(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function deValue(value, digits = null) {
  const parsed = numberValue(value);
  if (parsed === null) return '--';
  const formatted = digits === null ? String(value) : parsed.toFixed(digits);
  return formatted.replace('.', ',');
}

function trendClass(value) {
  if (value === '↑') return 'up';
  if (value === '↓') return 'down';
  return 'flat';
}

function normalizeRows(values, startTs, endTs) {
  return (Array.isArray(values) ? values : [])
    .map(row => ({
      ts: Number(row && row.ts),
      val: numberValue(row && row.val !== undefined ? row.val : row)
    }))
    .filter(row => Number.isFinite(row.ts) && Number.isFinite(row.val) && row.ts >= startTs && row.ts <= endTs)
    .sort((a, b) => a.ts - b.ts);
}

function compactRows(values, maxPoints) {
  const rows = Array.isArray(values) ? values : [];
  if (rows.length <= maxPoints) return rows;
  const sampled = [];
  for (let index = 0; index < maxPoints; index++) {
    sampled.push(rows[Math.round(index * (rows.length - 1) / (maxPoints - 1))]);
  }
  return sampled;
}

function addCurrentPoint(rows, value, now) {
  const parsed = numberValue(value);
  const result = Array.isArray(rows) ? rows.map(row => ({ ...row })) : [];
  if (parsed === null) return result;
  const last = result[result.length - 1];
  if (!last || now - last.ts > 15000 || Math.abs(last.val - parsed) > 0.0001) {
    result.push({ ts: now, val: parsed });
  }
  return result;
}

function scheduleItems(text) {
  const rows = String(text || '--')
    .split(/\n+/)
    .map(row => row.trim())
    .filter(Boolean)
    .slice(0, 4);

  if (!rows.length || (rows.length === 1 && rows[0] === '--')) {
    return '<span class="schedule-empty">Keine kommenden Schaltungen</span>';
  }

  return rows.map(row => `<span class="schedule-chip">${esc(row)}</span>`).join('');
}

function iconSvg(key) {
  const icons = {
    outside: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    water: '<svg viewBox="0 0 24 24"><path d="M12 2C8 7 5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-3-8-7-13Z"/><path d="M8.5 16.5c1.6 1.8 4.1 2.1 6 .7"/></svg>',
    ph: '<svg viewBox="0 0 24 24"><path d="M9 2h6M10 2v6l-5 9a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-9V2M8 15h8"/></svg>',
    orp: '<svg viewBox="0 0 24 24"><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z"/></svg>'
  };
  return icons[key] || icons.water;
}

function buildIpadMiniHtml(data = {}, cachedHistory = null) {
  const now = Date.now();
  const phOk = data.phInRange === true;
  const orpOk = data.orpInRange === true;
  const baseHistory = cachedHistory && cachedHistory.data ? cachedHistory.data : {
    '24h': { outside: [], water: [], ph: [], orp: [] },
    '7d': { outside: [], water: [], ph: [], orp: [] }
  };

  const chartData = {
    generatedAt: now,
    '24h': {
      outside: addCurrentPoint(baseHistory['24h'] && baseHistory['24h'].outside, data.outsideTemp, now),
      water: addCurrentPoint(baseHistory['24h'] && baseHistory['24h'].water, data.poolTemp, now),
      ph: addCurrentPoint(baseHistory['24h'] && baseHistory['24h'].ph, data.ph, now),
      orp: addCurrentPoint(baseHistory['24h'] && baseHistory['24h'].orp, data.orp, now)
    },
    '7d': {
      outside: addCurrentPoint(baseHistory['7d'] && baseHistory['7d'].outside, data.outsideTemp, now),
      water: addCurrentPoint(baseHistory['7d'] && baseHistory['7d'].water, data.poolTemp, now),
      ph: addCurrentPoint(baseHistory['7d'] && baseHistory['7d'].ph, data.ph, now),
      orp: addCurrentPoint(baseHistory['7d'] && baseHistory['7d'].orp, data.orp, now)
    }
  };
  const chartJson = JSON.stringify(chartData).replace(/</g, '\\u003c');

  const tile = ({ label, value, unit, accent, trend, icon, statusText }) => `
    <section class="metric-card ${accent}">
      <div class="metric-top">
        <span class="metric-icon">${iconSvg(icon)}</span>
        <span class="metric-label">${esc(label)}</span>
        <span class="metric-status">${esc(statusText || 'Aktuell')}</span>
      </div>
      <div class="metric-reading">
        <span class="metric-value">${esc(value)}</span>
        ${unit ? `<span class="metric-unit">${esc(unit)}</span>` : ''}
        ${trend ? `<span class="metric-trend ${trendClass(trend)}">${esc(trend)}</span>` : ''}
      </div>
    </section>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
  <title>Pool iPad Mini</title>
  <style>
    :root{
      --bg:#06101c;--panel:#0b1a2d;--panel2:#10243b;--line:rgba(255,255,255,.09);
      --text:#f7fbff;--muted:#8fa5bf;--outside:#57b9ff;--water:#55e0dc;
      --ph:${phOk ? '#66df7d' : '#ffbd59'};--orp:${orpOk ? '#66df7d' : '#ff9f59'};
      --green:#66df7d;--orange:#ffbd59;--red:#ff746b;
    }
    *{box-sizing:border-box}
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg)}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--text);-webkit-user-select:none;user-select:none}
    button{font:inherit}
    .screen{
      width:100vw;height:100vh;min-height:100%;padding:10px 12px 9px;
      display:grid;grid-template-rows:38px 146px minmax(0,1fr) 38px;gap:8px;
      background:
        radial-gradient(circle at 10% -10%,rgba(64,151,255,.22),transparent 34%),
        radial-gradient(circle at 100% 110%,rgba(48,220,196,.13),transparent 38%),
        linear-gradient(145deg,#06101c,#0a192a 55%,#07121f);
    }
    .header{display:flex;align-items:center;justify-content:space-between;padding:0 4px}
    .brand{display:flex;align-items:center;gap:10px}
    .brand-mark{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(145deg,#1f87d6,#29c7c2);box-shadow:0 6px 18px rgba(42,166,210,.24)}
    .brand-mark svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
    .brand-main{font-size:20px;font-weight:900;letter-spacing:.08em}
    .brand-sub{font-size:10px;color:var(--muted);font-weight:750;letter-spacing:.12em;text-transform:uppercase;margin-top:1px}
    .header-meta{text-align:right;color:var(--muted);font-size:9px;line-height:1.25}

    .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;min-width:0}
    .metric-card{
      --accent:var(--outside);position:relative;min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:16px;
      padding:13px 14px 12px;background:linear-gradient(150deg,rgba(18,39,64,.98),rgba(9,24,41,.98));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 10px 24px rgba(0,0,0,.18)
    }
    .metric-card:before{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--accent)}
    .metric-card:after{content:"";position:absolute;width:120px;height:120px;border-radius:50%;right:-58px;top:-66px;background:var(--accent);opacity:.07;filter:blur(1px)}
    .metric-card.outside{--accent:var(--outside)}.metric-card.water{--accent:var(--water)}.metric-card.ph{--accent:var(--ph)}.metric-card.orp{--accent:var(--orp)}
    .metric-top{position:relative;z-index:1;display:grid;grid-template-columns:25px 1fr auto;align-items:center;gap:7px}
    .metric-icon{width:25px;height:25px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 15%,transparent);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent)}
    .metric-icon svg{width:15px;height:15px;fill:none;stroke:var(--accent);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
    .metric-label{font-size:12px;color:#dce8f5;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .metric-status{font-size:8px;color:var(--muted);font-weight:750;text-transform:uppercase;letter-spacing:.06em}
    .metric-reading{height:87px;display:flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap;position:relative;z-index:1;padding-top:4px}
    .metric-value{font-size:58px;font-weight:920;line-height:.9;letter-spacing:-.055em;color:var(--accent);font-variant-numeric:tabular-nums;text-shadow:0 0 24px color-mix(in srgb,var(--accent) 18%,transparent)}
    .metric-unit{font-size:21px;font-weight:850;color:rgba(247,251,255,.77)}
    .metric-trend{font-size:24px;font-weight:900;margin-left:1px}.metric-trend.up{color:var(--green)}.metric-trend.down{color:var(--orange)}.metric-trend.flat{color:#aebdd0}

    .chart-panel{min-height:0;border:1px solid var(--line);border-radius:17px;background:linear-gradient(155deg,rgba(14,32,53,.98),rgba(7,20,35,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.03),0 12px 28px rgba(0,0,0,.18);padding:10px 12px 8px;display:grid;grid-template-rows:38px minmax(0,1fr);overflow:hidden}
    .chart-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
    .chart-heading{display:flex;align-items:center;gap:9px;min-width:0}
    .chart-title{font-size:13px;font-weight:900;letter-spacing:.03em;white-space:nowrap}.chart-subtitle{font-size:9px;color:var(--muted);font-weight:700;white-space:nowrap}
    .controls{display:flex;align-items:center;gap:7px}.segmented{display:flex;gap:3px;padding:3px;border:1px solid rgba(255,255,255,.07);background:rgba(4,14,25,.7);border-radius:11px}
    .chart-btn{border:0;border-radius:8px;background:transparent;color:var(--muted);padding:6px 10px;font-size:9px;font-weight:850;white-space:nowrap;cursor:pointer}
    .chart-btn.active{color:#fff;background:linear-gradient(145deg,rgba(55,142,218,.85),rgba(32,180,174,.72));box-shadow:0 4px 12px rgba(31,151,188,.18)}
    .chart-wrap{position:relative;min-height:0;overflow:hidden}.chart-svg{display:block;width:100%;height:100%;min-height:240px}
    .chart-empty{position:absolute;inset:0;display:none;place-items:center;color:var(--muted);font-size:12px;font-weight:750}.chart-empty.visible{display:grid}
    .chart-stats{position:absolute;right:8px;top:7px;display:flex;gap:5px;pointer-events:none}.stat-pill{border:1px solid rgba(255,255,255,.07);background:rgba(5,17,30,.7);border-radius:999px;padding:4px 7px;font-size:8px;color:#bed0e3;font-weight:750}

    .schedule{border:1px solid var(--line);border-radius:13px;background:rgba(10,27,46,.94);display:grid;grid-template-columns:auto 1fr;align-items:center;gap:10px;padding:5px 10px;min-width:0;overflow:hidden}
    .schedule-label{color:var(--muted);font-size:9px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}.schedule-list{display:flex;justify-content:flex-end;gap:5px;min-width:0;overflow:hidden}
    .schedule-chip{background:rgba(84,200,255,.09);border:1px solid rgba(84,200,255,.16);border-radius:999px;padding:4px 7px;font-size:8px;font-weight:750;color:#ddecff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:27%}.schedule-empty{color:var(--muted);font-size:9px;font-weight:700}

    @media (max-width:900px){.screen{grid-template-rows:36px 132px minmax(0,1fr) 38px}.metric-card{padding:11px}.metric-label{font-size:10px}.metric-value{font-size:49px}.metric-unit{font-size:18px}.metric-trend{font-size:21px}.chart-btn{padding:5px 7px}}
  </style>
</head>
<body>
  <main class="screen">
    <header class="header">
      <div class="brand">
        <span class="brand-mark">${iconSvg('water')}</span>
        <div><div class="brand-main">POOL</div><div class="brand-sub">Live Dashboard</div></div>
      </div>
      <div class="header-meta"><div>${esc(data.updated || '--')}</div><div>${ADAPTER_VERSION} · iPad Mini · 1024 × 768</div></div>
    </header>

    <section class="metrics">
      ${tile({ label:'Außentemperatur', value:deValue(data.outsideTemp,1), unit:'°C', accent:'outside', trend:data.outsideTempTrend || '', icon:'outside' })}
      ${tile({ label:'Wassertemperatur', value:deValue(data.poolTemp,1), unit:'°C', accent:'water', trend:data.poolTempTrend || '', icon:'water' })}
      ${tile({ label:'pH-Wert', value:deValue(data.ph,2), unit:'', accent:'ph', trend:data.phTrend || '', icon:'ph', statusText:phOk ? 'Im Ziel' : 'Prüfen' })}
      ${tile({ label:'ORP-Wert', value:deValue(data.orp,0), unit:'mV', accent:'orp', trend:data.orpTrend || '', icon:'orp', statusText:orpOk ? 'Im Ziel' : 'Prüfen' })}
    </section>

    <section class="chart-panel">
      <div class="chart-toolbar">
        <div class="chart-heading"><span class="chart-title" id="chartTitle">Temperaturentwicklung</span><span class="chart-subtitle" id="chartSubtitle">letzte 24 Stunden</span></div>
        <div class="controls">
          <div class="segmented" data-group="metric">
            <button class="chart-btn active" data-metric="temp">Temperaturen</button>
            <button class="chart-btn" data-metric="ph">pH</button>
            <button class="chart-btn" data-metric="orp">ORP</button>
          </div>
          <div class="segmented" data-group="range">
            <button class="chart-btn active" data-range="24h">24 h</button>
            <button class="chart-btn" data-range="7d">7 Tage</button>
          </div>
        </div>
      </div>
      <div class="chart-wrap">
        <svg class="chart-svg" id="trendChart" viewBox="0 0 960 330" preserveAspectRatio="none" aria-label="Werteentwicklung"></svg>
        <div class="chart-stats" id="chartStats"></div>
        <div class="chart-empty" id="chartEmpty">History sammelt noch Daten</div>
      </div>
    </section>

    <footer class="schedule">
      <div class="schedule-label">Nächste Schaltungen</div>
      <div class="schedule-list">${scheduleItems(data.nextActionsText)}</div>
    </footer>
  </main>

  <script>
  (function(){
    'use strict';
    var chartData = ${chartJson};
    var metricMode = 'temp';
    var rangeMode = '24h';
    var svg = document.getElementById('trendChart');
    var empty = document.getElementById('chartEmpty');
    var stats = document.getElementById('chartStats');
    var title = document.getElementById('chartTitle');
    var subtitle = document.getElementById('chartSubtitle');
    var NS = 'http://www.w3.org/2000/svg';

    var definitions = {
      temp: {
        title:'Temperaturentwicklung', unit:'°C', decimals:1, minRange:1.0,
        series:[
          {key:'outside',label:'Außen',color:'#57b9ff'},
          {key:'water',label:'Wasser',color:'#55e0dc'}
        ]
      },
      ph: {title:'pH-Entwicklung',unit:'',decimals:2,minRange:0.10,series:[{key:'ph',label:'pH',color:'#66df7d'}]},
      orp:{title:'ORP-Entwicklung',unit:'mV',decimals:0,minRange:30,series:[{key:'orp',label:'ORP',color:'#ff9f59'}]}
    };

    function el(name,attrs,text){
      var node=document.createElementNS(NS,name);
      Object.keys(attrs||{}).forEach(function(key){node.setAttribute(key,String(attrs[key]));});
      if(text!==undefined) node.textContent=text;
      return node;
    }

    function fmt(value,decimals){
      if(!Number.isFinite(value)) return '--';
      return Number(value).toFixed(decimals).replace('.',',');
    }

    function formatTime(ts,range){
      var d=new Date(ts);
      if(range==='7d') return String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')+'.';
      return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    }

    function seriesRows(key){
      var range=chartData[rangeMode]||{};
      return (Array.isArray(range[key])?range[key]:[]).filter(function(row){return row&&Number.isFinite(Number(row.ts))&&Number.isFinite(Number(row.val));}).map(function(row){return {ts:Number(row.ts),val:Number(row.val)};}).sort(function(a,b){return a.ts-b.ts;});
    }

    function setActiveButtons(){
      document.querySelectorAll('[data-metric]').forEach(function(btn){btn.classList.toggle('active',btn.getAttribute('data-metric')===metricMode);});
      document.querySelectorAll('[data-range]').forEach(function(btn){btn.classList.toggle('active',btn.getAttribute('data-range')===rangeMode);});
    }

    function render(){
      var def=definitions[metricMode];
      title.textContent=def.title;
      subtitle.textContent=rangeMode==='7d'?'letzte 7 Tage':'letzte 24 Stunden';
      setActiveButtons();
      while(svg.firstChild) svg.removeChild(svg.firstChild);
      stats.innerHTML='';

      var prepared=def.series.map(function(item){return {item:item,rows:seriesRows(item.key)};});
      var all=[];
      prepared.forEach(function(group){group.rows.forEach(function(row){all.push(row.val);});});
      var pointCount=prepared.reduce(function(sum,group){return sum+group.rows.length;},0);
      empty.classList.toggle('visible',pointCount<2);
      if(!all.length) return;

      var W=960,H=330,pad={l:56,r:18,t:22,b:34};
      var min=Math.min.apply(null,all),max=Math.max.apply(null,all);
      var visible=Math.max(max-min,def.minRange);
      var center=(min+max)/2;
      min=center-visible/2;max=center+visible/2;
      var margin=(max-min)*0.12;min-=margin;max+=margin;
      var end=Number(chartData.generatedAt)||Date.now();
      var start=end-(rangeMode==='7d'?7*24*60*60*1000:24*60*60*1000);
      var x=function(ts){return pad.l+Math.max(0,Math.min(1,(ts-start)/(end-start)))*(W-pad.l-pad.r);};
      var y=function(value){return pad.t+(1-(value-min)/(max-min))*(H-pad.t-pad.b);};

      var defs=el('defs');
      prepared.forEach(function(group,index){
        var grad=el('linearGradient',{id:'area'+index,x1:'0',x2:'0',y1:'0',y2:'1'});
        grad.appendChild(el('stop',{offset:'0%','stop-color':group.item.color,'stop-opacity':'0.23'}));
        grad.appendChild(el('stop',{offset:'100%','stop-color':group.item.color,'stop-opacity':'0'}));
        defs.appendChild(grad);
      });
      svg.appendChild(defs);

      for(var gy=0;gy<=4;gy++){
        var yy=pad.t+gy*(H-pad.t-pad.b)/4;
        svg.appendChild(el('line',{x1:pad.l,y1:yy,x2:W-pad.r,y2:yy,stroke:'rgba(255,255,255,.075)','stroke-width':'1'}));
        var label=max-gy*(max-min)/4;
        svg.appendChild(el('text',{x:pad.l-9,y:yy+4,'text-anchor':'end',fill:'#8298b1','font-size':'11','font-weight':'700'},fmt(label,def.decimals)));
      }
      for(var gx=0;gx<=4;gx++){
        var xx=pad.l+gx*(W-pad.l-pad.r)/4;
        svg.appendChild(el('line',{x1:xx,y1:pad.t,x2:xx,y2:H-pad.b,stroke:'rgba(255,255,255,.045)','stroke-width':'1'}));
        svg.appendChild(el('text',{x:xx,y:H-10,'text-anchor':gx===0?'start':gx===4?'end':'middle',fill:'#8298b1','font-size':'10','font-weight':'700'},formatTime(start+gx*(end-start)/4,rangeMode)));
      }

      prepared.forEach(function(group,index){
        if(!group.rows.length) return;
        var points=group.rows.map(function(row){return [x(row.ts),y(row.val)];});
        var linePath='M '+points.map(function(p){return p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' L ');
        if(points.length>1){
          var areaPath=linePath+' L '+points[points.length-1][0].toFixed(1)+' '+(H-pad.b)+' L '+points[0][0].toFixed(1)+' '+(H-pad.b)+' Z';
          svg.appendChild(el('path',{d:areaPath,fill:'url(#area'+index+')'}));
        }
        svg.appendChild(el('path',{d:linePath,fill:'none',stroke:group.item.color,'stroke-width':'3','stroke-linecap':'round','stroke-linejoin':'round'}));
        var last=points[points.length-1];
        svg.appendChild(el('circle',{cx:last[0],cy:last[1],r:'4.2',fill:group.item.color,stroke:'#07121f','stroke-width':'2'}));

        var values=group.rows.map(function(row){return row.val;});
        var lastValue=values[values.length-1];
        var minValue=Math.min.apply(null,values);
        var maxValue=Math.max.apply(null,values);
        var pill=document.createElement('span');
        pill.className='stat-pill';
        pill.style.borderColor=group.item.color+'44';
        pill.textContent=group.item.label+' '+fmt(lastValue,def.decimals)+(def.unit?' '+def.unit:'')+' · Min '+fmt(minValue,def.decimals)+' · Max '+fmt(maxValue,def.decimals);
        stats.appendChild(pill);
      });

      var legendX=pad.l+4;
      prepared.forEach(function(group){
        svg.appendChild(el('circle',{cx:legendX,cy:12,r:'4',fill:group.item.color}));
        svg.appendChild(el('text',{x:legendX+8,y:16,fill:'#c7d7e8','font-size':'11','font-weight':'800'},group.item.label));
        legendX+=group.item.label.length*7+42;
      });
    }

    document.querySelectorAll('[data-metric]').forEach(function(btn){btn.addEventListener('click',function(){metricMode=btn.getAttribute('data-metric')||'temp';render();});});
    document.querySelectorAll('[data-range]').forEach(function(btn){btn.addEventListener('click',function(){rangeMode=btn.getAttribute('data-range')||'24h';render();});});
    render();
  })();
  </script>
</body>
</html>`;
}

function installIpadMiniDashboard(adapter) {
  if (!adapter || adapter.__ipadMiniDashboardInstalled) return adapter;
  adapter.__ipadMiniDashboardInstalled = true;
  adapter.__ipadMiniDashboardData = null;
  adapter.__ipadMiniHistoryCache = {
    ts: 0,
    data: {
      '24h': { outside: [], water: [], ph: [], orp: [] },
      '7d': { outside: [], water: [], ph: [], orp: [] }
    }
  };
  adapter.__ipadMiniHistoryPromise = null;

  async function readLocalRows(stateId, startTs, endTs) {
    try {
      const raw = await adapter.getText(stateId, '[]');
      const parsed = JSON.parse(raw || '[]');
      return normalizeRows(parsed, startTs, endTs);
    } catch {
      return [];
    }
  }

  async function fetchRows(stateId, startTs, endTs, count) {
    if (!stateId || typeof adapter.fetchHistoryValues !== 'function') return [];
    try {
      const values = await adapter.fetchHistoryValues(stateId, startTs, endTs, 'average', count);
      return normalizeRows(values, startTs, endTs);
    } catch (error) {
      if (adapter.config.debugMode) adapter.log.debug('[IPAD-MINI] History fehlgeschlagen für ' + stateId + ': ' + (error.message || error));
      return [];
    }
  }

  async function refreshHistory(force = false) {
    const cache = adapter.__ipadMiniHistoryCache;
    if (!force && cache.ts && Date.now() - cache.ts < HISTORY_CACHE_MS) return cache;
    const now = Date.now();
    const ids = {
      outside: String(adapter.config.outsideTempStateId || '').trim(),
      water: String(adapter.config.waterTempStateId || '').trim(),
      ph: String(adapter.config.phStateId || '').trim(),
      orp: String(adapter.config.orpStateId || '').trim()
    };

    const keys = ['outside', 'water', 'ph', 'orp'];
    const data24 = {};
    const data7 = {};
    await Promise.all(keys.map(async function(key) {
      data24[key] = compactRows(await fetchRows(ids[key], now - RANGE_24H_MS, now, 144), 144);
      data7[key] = compactRows(await fetchRows(ids[key], now - RANGE_7D_MS, now, 168), 168);
    }));

    if (!data24.ph.length) data24.ph = await readLocalRows(adapter.namespace + '.status.trend.phTodayJson', now - RANGE_24H_MS, now);
    if (!data24.orp.length) data24.orp = await readLocalRows(adapter.namespace + '.status.trend.orpTodayJson', now - RANGE_24H_MS, now);
    if (!data24.water.length) data24.water = await readLocalRows(adapter.namespace + '.status.trend.poolTemp24hJson', now - RANGE_24H_MS, now);

    adapter.__ipadMiniHistoryCache = { ts: now, data: { '24h': data24, '7d': data7 } };
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    try { adapter.queueRender(); } catch {}
    return adapter.__ipadMiniHistoryCache;
  }

  function startHistoryRefresh(force = false) {
    const cache = adapter.__ipadMiniHistoryCache;
    if (!force && cache.ts && Date.now() - cache.ts < HISTORY_CACHE_MS) return Promise.resolve(cache);
    if (adapter.__ipadMiniHistoryPromise) return adapter.__ipadMiniHistoryPromise;
    adapter.__ipadMiniHistoryPromise = refreshHistory(force)
      .catch(error => {
        adapter.log.warn('[IPAD-MINI] Verlauf konnte nicht aktualisiert werden: ' + (error.message || error));
        return adapter.__ipadMiniHistoryCache;
      })
      .finally(() => { adapter.__ipadMiniHistoryPromise = null; });
    return adapter.__ipadMiniHistoryPromise;
  }

  const builders = ['buildTabletHtml', 'buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget'];
  for (const methodName of builders) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchedBuilder(data) {
      if (methodName === 'buildTabletHtml') adapter.__ipadMiniDashboardData = { ...(data || {}) };
      const html = original({ ...(data || {}), adapterVersion: ADAPTER_VERSION });
      return String(html || '').replace(/v0\.4\.[5-7]/g, ADAPTER_VERSION);
    };
  }

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async function renderVisFullWithIpadMini(force = false) {
    await this.ensureState(IPAD_MINI_STATE, 'string', 'html', '', false);
    startHistoryRefresh(false);
    const result = await baseRenderVisFull(force);
    const data = this.__ipadMiniDashboardData;
    if (data) {
      const html = buildIpadMiniHtml(data, this.__ipadMiniHistoryCache);
      await this.setStateIfChanged(IPAD_MINI_STATE, html, true);
    }
    return result;
  };

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState(IPAD_MINI_STATE, 'string', 'html', '', false);
        await startHistoryRefresh(true);
        await adapter.forceImmediateRender();
      } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Initialisierung fehlgeschlagen: ' + (error.message || error));
      }
    }, 2500));
  });

  try {
    adapter.log.info('[IPAD-MINI] v0.4.8: KPI-Dashboard mit interaktivem 24h/7d-Verlauf aktiv');
  } catch {}

  return adapter;
}

function createAdapter(options = {}) {
  return installIpadMiniDashboard(createWeightAdapter(options));
}

if (require.main !== module) {
  module.exports = createAdapter;
} else {
  createAdapter();
}

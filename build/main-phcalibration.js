'use strict';

const createBase = require('./main-ipadmini-heatpump.js');

const VERSION = 'v0.4.12';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const VIS_ID = 'vis.htmlPhCalibration';
const POINTS_ID = 'status.phCalibration.pointsJson';
const INIT_ID = 'status.phCalibration.initialized';
const FALLBACK = -0.21;
const FIRST = { raw: 7.39, ref: 7.23 };

const num = value => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};
const rnd = (value, digits = 3) => Math.round(Number(value) * (10 ** digits)) / (10 ** digits);
const fmt = (value, digits = 2) => num(value) === null ? '--' : num(value).toFixed(digits).replace('.', ',');
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function normalizePoints(value) {
  const points = (Array.isArray(value) ? value : []).map(point => {
    const raw = num(point && point.raw);
    const ref = num(point && (point.ref !== undefined ? point.ref : point.poollab));
    if (raw === null || ref === null || raw < 0 || raw > 14 || ref < 0 || ref > 14) return null;
    return { raw: rnd(raw), ref: rnd(ref), delta: rnd(ref - raw), ts: Number(point.ts) || Date.now() };
  }).filter(Boolean);
  return points.sort((a, b) => b.ts - a.ts).slice(0, 40).sort((a, b) => a.raw - b.raw);
}

function calculate(rawValue, pointValue) {
  const raw = num(rawValue);
  const points = normalizePoints(pointValue);
  if (raw === null) return null;
  if (!points.length) return rnd(raw + FALLBACK);
  if (points.length === 1) return rnd(raw + points[0].delta);
  if (raw <= points[0].raw) return rnd(raw + points[0].delta);
  const last = points[points.length - 1];
  if (raw >= last.raw) return rnd(raw + last.delta);
  for (let i = 1; i < points.length; i++) {
    const right = points[i];
    if (raw > right.raw) continue;
    const left = points[i - 1];
    const factor = (raw - left.raw) / Math.max(0.000001, right.raw - left.raw);
    return rnd(raw + left.delta + (right.delta - left.delta) * factor);
  }
  return rnd(raw + last.delta);
}

function addPoint(points, rawValue, refValue) {
  const raw = rnd(rawValue);
  const ref = rnd(refValue);
  const result = normalizePoints(points);
  const index = result.findIndex(point => Math.abs(point.raw - raw) <= 0.02);
  const next = { raw, ref, delta: rnd(ref - raw), ts: Date.now() };
  if (index >= 0) result[index] = next;
  else result.push(next);
  return normalizePoints(result);
}

function buildHtml(data) {
  const points = normalizePoints(data.points);
  const rows = [...points].sort((a, b) => b.ts - a.ts).slice(0, 8).map(point =>
    `<tr><td>${fmt(point.raw)}</td><td>${fmt(point.ref)}</td><td>${point.delta >= 0 ? '+' : ''}${fmt(point.delta)}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="empty">Noch keine Kalibrierpunkte</td></tr>';
  const delta = data.delta === null ? '--' : `${data.delta >= 0 ? '+' : ''}${fmt(data.delta)}`;
  const input = num(data.input) === null ? '7.23' : Number(data.input).toFixed(2);
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#f5fbff}.box{min-height:100%;padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:linear-gradient(150deg,#10243a,#071423);box-shadow:0 12px 28px rgba(0,0,0,.2)}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.title{font-size:17px;font-weight:900}.sub,.hint{font-size:9px;color:#9db0c5}.count{font-size:10px;font-weight:850;padding:5px 9px;border-radius:999px;color:#dcecff;background:rgba(85,200,255,.11);border:1px solid rgba(85,200,255,.2)}.values{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:9px}.value{padding:8px;border-radius:11px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.06)}.label{font-size:8px;color:#9db0c5;font-weight:850;text-transform:uppercase}.number{font-size:22px;font-weight:900;margin-top:2px}.raw{color:#55c8ff}.corr{color:#68df7e}.delta{color:#ffbd59}.form{display:grid;grid-template-columns:1fr auto;gap:8px}.inputWrap{position:relative}.inputWrap label{position:absolute;top:5px;left:11px;font-size:8px;color:#9db0c5;font-weight:850;text-transform:uppercase}.input{width:100%;height:52px;border:1px solid rgba(85,200,255,.3);border-radius:12px;background:rgba(3,14,25,.55);color:#fff;padding:18px 42px 4px 11px;font-size:24px;font-weight:900;outline:none}.unit{position:absolute;right:11px;bottom:9px;color:#9db0c5;font-size:11px;font-weight:800}.save{height:52px;border:0;border-radius:12px;padding:0 16px;color:#fff;background:linear-gradient(145deg,#278bd4,#25bfb5);font-size:11px;font-weight:900}.save:disabled{opacity:.55}.message{margin:8px 0;padding:6px 8px;border-radius:9px;font-size:10px;font-weight:750;color:#b7f6c4;background:rgba(70,194,98,.11)}.message.error{color:#ffd0cb;background:rgba(255,119,109,.12)}table{width:100%;border-collapse:collapse;font-size:10px}th,td{text-align:left;padding:5px 7px;border-bottom:1px solid rgba(255,255,255,.06)}th{font-size:8px;color:#9db0c5;text-transform:uppercase}.empty{text-align:center;color:#9db0c5;padding:12px}.foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px}.reset{border:1px solid rgba(255,119,109,.22);border-radius:9px;padding:6px 8px;color:#ffc2bc;background:rgba(255,119,109,.08);font-size:8px;font-weight:850;white-space:nowrap}
</style></head><body><section class="box"><div class="head"><div><div class="title">PoolLab pH-Kalibrierung</div><div class="sub">PH803-Rohwert mit PoolLab abgleichen</div></div><span class="count">${points.length} Punkte</span></div><div class="values"><div class="value"><div class="label">PH803 roh</div><div class="number raw">${fmt(data.raw)}</div></div><div class="value"><div class="label">Korrigiert</div><div class="number corr">${fmt(data.corrected)}</div></div><div class="value"><div class="label">Korrektur</div><div class="number delta">${delta}</div></div></div><div class="form"><div class="inputWrap"><label for="poollab">PoolLab-Messwert</label><input id="poollab" class="input" type="number" min="0" max="14" step="0.01" inputmode="decimal" value="${input}"><span class="unit">pH</span></div><button id="save" class="save">Messwert speichern</button></div><div id="message" class="message ${data.error ? 'error' : ''}">${esc(data.message || 'PoolLab-Wert eingeben und direkt speichern.')}</div><table><thead><tr><th>PH803 roh</th><th>PoolLab</th><th>Korrektur</th></tr></thead><tbody>${rows}</tbody></table><div class="foot"><span class="hint">Zwischen den Punkten wird linear interpoliert.</span><button id="reset" class="reset">Tabelle löschen</button></div></section><script>
(function(){var ns=${JSON.stringify(data.namespace)};function api(){try{if(window.vis)return window.vis}catch(e){}try{if(window.parent&&window.parent.vis)return window.parent.vis}catch(e){}try{if(window.top&&window.top.vis)return window.top.vis}catch(e){}return null}function conn(){try{var v=api();if(v&&v.conn&&typeof v.conn.setState==='function')return v.conn}catch(e){}return null}async function setState(id,val){var v=api(),c=conn();try{if(v&&typeof v.setValue==='function'){var r=v.setValue(id,val);if(r&&r.then)await r;return true}}catch(e){}if(!c)return false;var f=[function(){return c.setState(id,val)},function(){return c.setState(id,val,false)},function(){return c.setState(id,val,function(){})}];for(var i=0;i<f.length;i++){try{var x=f[i]();if(x&&x.then)await x;return true}catch(e){}}return false}var input=document.getElementById('poollab'),save=document.getElementById('save'),msg=document.getElementById('message');save.onclick=async function(){var value=Number(String(input.value||'').replace(',','.'));if(!Number.isFinite(value)||value<0||value>14){msg.textContent='Bitte einen gültigen pH-Wert eingeben.';msg.className='message error';return}save.disabled=true;save.textContent='Speichere …';var ok1=await setState(ns+'.control.ph.calibration.poollabValue',value);var ok2=await setState(ns+'.control.ph.calibration.saveTrigger',Date.now());msg.textContent=ok1&&ok2?'Messwert wird mit dem aktuellen PH803-Rohwert gespeichert …':'VIS setState ist nicht verfügbar.';msg.className=ok1&&ok2?'message':'message error';setTimeout(function(){save.disabled=false;save.textContent='Messwert speichern'},1800)};document.getElementById('reset').onclick=async function(){if(confirm('Alle PoolLab-Kalibrierpunkte löschen?'))await setState(ns+'.control.ph.calibration.resetTrigger',Date.now())}})();
</script></body></html>`;
}

function install(adapter) {
  if (!adapter || adapter.__phCalibrationInstalled) return adapter;
  adapter.__phCalibrationInstalled = true;
  adapter.__phCalibrationPoints = [];
  adapter.__phCalibrationMessage = '';
  adapter.__phCalibrationError = false;
  adapter.__phCalibrationOwnWriteUntil = 0;
  adapter.__phCalibrationRewriteTimer = null;

  async function ensureStates() {
    await adapter.ensureState('control.ph.calibration.poollabValue', 'number', 'value.ph', FIRST.ref, true);
    await adapter.ensureState('control.ph.calibration.saveTrigger', 'number', 'value.time', 0, true);
    await adapter.ensureState('control.ph.calibration.resetTrigger', 'number', 'value.time', 0, true);
    await adapter.ensureState(POINTS_ID, 'string', 'json', '[]', false);
    await adapter.ensureState(INIT_ID, 'boolean', 'indicator', false, false);
    await adapter.ensureState('status.phCalibration.count', 'number', 'value', 0, false);
    await adapter.ensureState('status.phCalibration.currentRaw', 'number', 'value.ph', 0, false);
    await adapter.ensureState('status.phCalibration.currentCorrected', 'number', 'value.ph', 0, false);
    await adapter.ensureState('status.phCalibration.currentDelta', 'number', 'value', 0, false);
    await adapter.ensureState('status.phCalibration.lastPoollab', 'number', 'value.ph', 0, false);
    await adapter.ensureState('status.phCalibration.lastRaw', 'number', 'value.ph', 0, false);
    await adapter.ensureState('status.phCalibration.lastSavedTs', 'number', 'value.time', 0, false);
    await adapter.ensureState('status.phCalibration.lastMessage', 'string', 'text', '', false);
    await adapter.ensureState(VIS_ID, 'string', 'html', '', false);
  }

  async function savePoints() {
    adapter.__phCalibrationPoints = normalizePoints(adapter.__phCalibrationPoints);
    await adapter.setStateIfChanged(POINTS_ID, JSON.stringify(adapter.__phCalibrationPoints), true);
    await adapter.setStateIfChanged('status.phCalibration.count', adapter.__phCalibrationPoints.length, true);
  }

  async function loadPoints() {
    try {
      const state = await adapter.getStateAsync(POINTS_ID);
      adapter.__phCalibrationPoints = normalizePoints(JSON.parse(String((state && state.val) || '[]')));
    } catch { adapter.__phCalibrationPoints = []; }
    const initializedState = await adapter.getStateAsync(INIT_ID);
    if (!adapter.__phCalibrationPoints.length && !(initializedState && initializedState.val === true)) {
      adapter.__phCalibrationPoints = addPoint([], FIRST.raw, FIRST.ref);
      adapter.__phCalibrationMessage = 'Startpunkt übernommen: PH803 7,39 → PoolLab 7,23.';
      await savePoints();
      await adapter.setStateIfChanged(INIT_ID, true, true);
    }
  }

  async function rawState() {
    try { return await adapter.getForeignStateAsync(RAW_ID); } catch { return null; }
  }

  async function renderWidget() {
    const source = await rawState();
    const raw = num(source && source.val);
    const corrected = calculate(raw, adapter.__phCalibrationPoints);
    const inputState = await adapter.getStateAsync('control.ph.calibration.poollabValue');
    const messageState = await adapter.getStateAsync('status.phCalibration.lastMessage');
    await adapter.setStateIfChanged(VIS_ID, buildHtml({
      namespace: adapter.namespace,
      raw,
      corrected,
      delta: raw === null || corrected === null ? null : rnd(corrected - raw),
      input: num(inputState && inputState.val) ?? FIRST.ref,
      points: adapter.__phCalibrationPoints,
      message: adapter.__phCalibrationMessage || String((messageState && messageState.val) || ''),
      error: adapter.__phCalibrationError
    }), true);
  }

  async function applyCorrection(reason = '') {
    const source = await rawState();
    const raw = num(source && source.val);
    if (raw === null) {
      adapter.__phCalibrationMessage = 'PH803-Rohwert ist nicht verfügbar.';
      adapter.__phCalibrationError = true;
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', adapter.__phCalibrationMessage, true);
      await renderWidget();
      return;
    }
    const corrected = calculate(raw, adapter.__phCalibrationPoints);
    const delta = rnd(corrected - raw);
    await adapter.setStateIfChanged('status.phCalibration.currentRaw', rnd(raw), true);
    await adapter.setStateIfChanged('status.phCalibration.currentCorrected', corrected, true);
    await adapter.setStateIfChanged('status.phCalibration.currentDelta', delta, true);
    try {
      const target = await adapter.getForeignStateAsync(OUT_ID);
      const current = num(target && target.val);
      if (current === null || Math.abs(current - corrected) > 0.0005) {
        adapter.__phCalibrationOwnWriteUntil = Date.now() + 1200;
        await adapter.setForeignStateAsync(OUT_ID, corrected, true);
        if (adapter.config.debugMode) adapter.log.debug(`[PH-KAL] ${reason}: ${raw} → ${corrected}`);
      }
    } catch (error) {
      adapter.__phCalibrationMessage = 'value_korr konnte nicht geschrieben werden: ' + (error.message || error);
      adapter.__phCalibrationError = true;
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', adapter.__phCalibrationMessage, true);
    }
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    try { adapter.queueRender(); } catch {}
    await renderWidget();
  }

  async function saveMeasurement() {
    const inputState = await adapter.getStateAsync('control.ph.calibration.poollabValue');
    const poollab = num(inputState && inputState.val);
    const source = await rawState();
    const raw = num(source && source.val);
    if (poollab === null || poollab < 0 || poollab > 14) {
      adapter.__phCalibrationMessage = 'PoolLab-Wert ist ungültig.';
      adapter.__phCalibrationError = true;
    } else if (raw === null || raw < 0 || raw > 14) {
      adapter.__phCalibrationMessage = 'PH803-Rohwert ist ungültig oder nicht erreichbar.';
      adapter.__phCalibrationError = true;
    } else {
      const replaced = adapter.__phCalibrationPoints.some(point => Math.abs(point.raw - raw) <= 0.02);
      adapter.__phCalibrationPoints = addPoint(adapter.__phCalibrationPoints, raw, poollab);
      await savePoints();
      const delta = rnd(poollab - raw);
      const age = source && source.ts ? Math.max(0, Math.round((Date.now() - Number(source.ts)) / 1000)) : null;
      adapter.__phCalibrationMessage = `${replaced ? 'Kalibrierpunkt aktualisiert' : 'Kalibrierpunkt gespeichert'}: PH803 ${fmt(raw)} → PoolLab ${fmt(poollab)} (${delta >= 0 ? '+' : ''}${fmt(delta)})${age === null ? '' : ` · Rohwert ${age}s alt`}.`;
      adapter.__phCalibrationError = false;
      await adapter.setStateIfChanged('status.phCalibration.lastPoollab', rnd(poollab), true);
      await adapter.setStateIfChanged('status.phCalibration.lastRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.lastSavedTs', Date.now(), true);
      await applyCorrection('PoolLab-Messung');
    }
    await adapter.setStateIfChanged('status.phCalibration.lastMessage', adapter.__phCalibrationMessage, true);
    await renderWidget();
  }

  async function reset() {
    adapter.__phCalibrationPoints = [];
    await savePoints();
    await adapter.setStateIfChanged(INIT_ID, true, true);
    adapter.__phCalibrationMessage = 'Kalibriertabelle gelöscht. Fallback ist wieder −0,21.';
    adapter.__phCalibrationError = true;
    await adapter.setStateIfChanged('status.phCalibration.lastMessage', adapter.__phCalibrationMessage, true);
    await applyCorrection('Reset');
  }

  function rewriteSoon() {
    if (adapter.__phCalibrationRewriteTimer) {
      try { adapter.clearTrackedTimeout(adapter.__phCalibrationRewriteTimer); } catch {}
    }
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      adapter.__phCalibrationRewriteTimer = null;
      if (!adapter.isShuttingDown) await applyCorrection('value_korr überschrieben');
    }, 350));
    adapter.__phCalibrationRewriteTimer = handle;
  }

  for (const name of ['buildTabletHtml', 'buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => String(original({ ...(data || {}), adapterVersion: VERSION })).replace(/v0\.4\.(?:5|6|7|8|9|10|11)/g, VERSION);
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await ensureStates();
        await loadPoints();
        try { adapter.subscribeForeignStates(RAW_ID); } catch {}
        try { adapter.subscribeForeignStates(OUT_ID); } catch {}
        await adapter.setStateIfChanged('status.phCalibration.lastMessage', adapter.__phCalibrationMessage || 'PoolLab-Kalibrierung aktiv.', true);
        await applyCorrection('Adapterstart');
      } catch (error) {
        if (!adapter.isDbClosedError(error)) adapter.log.warn('[PH-KAL] Start fehlgeschlagen: ' + (error.message || error));
      }
    }, 5200));
  });

  adapter.on('stateChange', async (id, state) => {
    if (!state || adapter.isShuttingDown) return;
    try {
      if (id === RAW_ID) return await applyCorrection('PH803 geändert');
      if (id === OUT_ID) {
        if (Date.now() <= adapter.__phCalibrationOwnWriteUntil) return;
        const source = await rawState();
        const desired = calculate(source && source.val, adapter.__phCalibrationPoints);
        const actual = num(state.val);
        if (desired !== null && (actual === null || Math.abs(actual - desired) > 0.0005)) rewriteSoon();
        return;
      }
      if (id === `${adapter.namespace}.control.ph.calibration.saveTrigger` && state.ack !== true) {
        await adapter.setStateAsync('control.ph.calibration.saveTrigger', Number(state.val) || Date.now(), true);
        return await saveMeasurement();
      }
      if (id === `${adapter.namespace}.control.ph.calibration.resetTrigger` && state.ack !== true) {
        await adapter.setStateAsync('control.ph.calibration.resetTrigger', Number(state.val) || Date.now(), true);
        return await reset();
      }
      if (id === `${adapter.namespace}.control.ph.calibration.poollabValue` && state.ack !== true) await renderWidget();
    } catch (error) {
      if (!adapter.isDbClosedError(error)) adapter.log.warn('[PH-KAL] Verarbeitung fehlgeschlagen: ' + (error.message || error));
    }
  });

  try { adapter.log.info('[PH-KAL] v0.4.12: PoolLab-Eingabe und Korrekturkennlinie aktiv'); } catch {}
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

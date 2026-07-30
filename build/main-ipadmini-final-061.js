'use strict';

const createBase = require('./main-ipadmini-final-060.js');

const VERSION = 'v0.4.61';
const POOLLAB_ID = 'control.ph.calibration.poollabValue';
const SAVE_TRIGGER_ID = 'control.ph.calibration.saveTrigger';
const EDIT_STATE = 'control.ph.calibration.ipadMiniEditing';
const POINTS_ID = 'status.phCalibration.pointsJson';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const IPAD_ID = 'vis.htmlIpadMini';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', IPAD_ID];

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function rnd(value, digits = 3) {
  return Math.round(Number(value) * (10 ** digits)) / (10 ** digits);
}

function fmt(value) {
  const parsed = num(value);
  return parsed === null ? '--' : parsed.toFixed(2).replace('.', ',');
}

function normalizePoints(value) {
  const source = Array.isArray(value) ? value : [];
  return source.map(point => {
    const raw = num(point && point.raw);
    const ref = num(point && (point.ref !== undefined ? point.ref : point.poollab));
    if (raw === null || ref === null || raw < 0 || raw > 14 || ref < 0 || ref > 14) return null;
    return {
      raw: rnd(raw),
      ref: rnd(ref),
      delta: rnd(ref - raw),
      ts: Number(point.ts) || Date.now()
    };
  }).filter(Boolean).sort((a, b) => a.raw - b.raw);
}

function addPoint(pointsValue, rawValue, refValue) {
  const points = normalizePoints(pointsValue);
  const raw = rnd(rawValue);
  const ref = rnd(refValue);
  const next = { raw, ref, delta: rnd(ref - raw), ts: Date.now() };
  const index = points.findIndex(point => Math.abs(point.raw - raw) <= 0.02);
  if (index >= 0) points[index] = next;
  else points.push(next);
  return normalizePoints(points).slice(-40);
}

function calculate(rawValue, pointsValue) {
  const raw = num(rawValue);
  const points = normalizePoints(pointsValue);
  if (raw === null || !points.length) return null;
  if (points.length === 1) return rnd(raw + points[0].delta);
  if (raw <= points[0].raw) return rnd(raw + points[0].delta);
  const last = points[points.length - 1];
  if (raw >= last.raw) return rnd(raw + last.delta);
  for (let index = 1; index < points.length; index++) {
    const right = points[index];
    if (raw > right.raw) continue;
    const left = points[index - 1];
    const factor = (raw - left.raw) / Math.max(0.000001, right.raw - left.raw);
    const delta = left.delta + ((right.delta - left.delta) * factor);
    return rnd(raw + delta);
  }
  return rnd(raw + last.delta);
}

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stateWriterCode(namespace, relativeId, valueExpression) {
  const fullId = `${String(namespace || 'poolsteuerung.0')}.${relativeId}`
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
  return [
    "var v=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    `if(v){if(typeof v.setValue==='function'){v.setValue('${fullId}',${valueExpression})}else if(v.conn&&typeof v.conn.setState==='function'){v.conn.setState('${fullId}',${valueExpression})}}`
  ].join(';');
}

function buildOpenHandler(namespace) {
  const editOn = stateWriterCode(namespace, EDIT_STATE, 'true');
  return escapeAttribute([
    'event.preventDefault()',
    'event.stopPropagation()',
    "var m=document.getElementById('pool-ph-cal-modal-061')",
    "var i=document.getElementById('pool-ph-cal-input-061')",
    "var t=document.getElementById('pool-ph-cal-msg-061')",
    "if(t){t.textContent='PoolLab-Wert eingeben und speichern.';t.className='pool-ph-cal-msg-061'}",
    "if(i)i.value=''",
    "if(m)m.style.display='flex'",
    editOn,
    'setTimeout(function(){if(i)i.focus()},50)',
    'return false'
  ].join(';'));
}

function buildCloseHandler(namespace) {
  const editOff = stateWriterCode(namespace, EDIT_STATE, 'false');
  return escapeAttribute([
    'event.stopPropagation()',
    "var m=document.getElementById('pool-ph-cal-modal-061')",
    "if(m)m.style.display='none'",
    editOff,
    'return false'
  ].join(';'));
}

function buildSaveHandler(namespace) {
  const poollabId = `${String(namespace || 'poolsteuerung.0')}.${POOLLAB_ID}`
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
  const editId = `${String(namespace || 'poolsteuerung.0')}.${EDIT_STATE}`
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

  return escapeAttribute([
    'event.preventDefault()',
    'event.stopPropagation()',
    'var b=this',
    "var i=document.getElementById('pool-ph-cal-input-061')",
    "var m=document.getElementById('pool-ph-cal-modal-061')",
    "var t=document.getElementById('pool-ph-cal-msg-061')",
    "var x=Number(String(i&&i.value||'').trim().replace(',','.'))",
    "if(!Number.isFinite(x)||x<0||x>14){if(t){t.textContent='Bitte einen gültigen pH-Wert eingeben.';t.className='pool-ph-cal-msg-061 error'};if(i)i.focus();return false}",
    "var v=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    "if(!v){if(t){t.textContent='VIS-Verbindung nicht verfügbar.';t.className='pool-ph-cal-msg-061 error'};return false}",
    "function w(id,val){if(typeof v.setValue==='function')return Promise.resolve(v.setValue(id,val));if(v.conn&&typeof v.conn.setState==='function')return Promise.resolve(v.conn.setState(id,val));return Promise.reject(new Error('setState nicht verfügbar'))}",
    "b.disabled=true;b.textContent='Speichere …'",
    `w('${poollabId}',x).then(function(){if(t){t.textContent='Wert übertragen – Kalibrierpunkt wird gespeichert.';t.className='pool-ph-cal-msg-061 ok'};b.textContent='Übertragen';setTimeout(function(){w('${editId}',false);if(m)m.style.display='none';b.disabled=false;b.textContent='Speichern'},1200)},function(){if(t){t.textContent='Übertragung fehlgeschlagen.';t.className='pool-ph-cal-msg-061 error'};b.disabled=false;b.textContent='Speichern'})`,
    'return false'
  ].join(';'));
}

function buildIpadModal(namespace) {
  const open = buildOpenHandler(namespace);
  const close = buildCloseHandler(namespace);
  const save = buildSaveHandler(namespace);
  return {
    open,
    html: `<style data-ph-cal-061="1">
.pool-ph-cal-open-061{cursor:pointer}.pool-ph-cal-open-061:hover{filter:brightness(1.06)}
.pool-ph-cal-modal-061{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(2,8,18,.76);backdrop-filter:blur(5px)}
.pool-ph-cal-box-061{width:min(380px,92vw);padding:19px;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:linear-gradient(155deg,#173457,#081827);box-shadow:0 24px 65px rgba(0,0,0,.5);color:#fff;font-family:"Segoe UI Variable","Segoe UI",Arial,sans-serif}
.pool-ph-cal-title-061{font-size:20px;font-weight:760}.pool-ph-cal-sub-061{margin-top:3px;color:#a9bdd2;font-size:12px}
.pool-ph-cal-input-061{width:100%;height:58px;margin-top:15px;border:1px solid rgba(85,200,255,.5);border-radius:12px;background:#061522;color:#fff;padding:6px 12px;font-size:28px;font-weight:760;outline:none}
.pool-ph-cal-input-061:focus{border-color:#55c8ff;box-shadow:0 0 0 3px rgba(85,200,255,.14)}
.pool-ph-cal-msg-061{min-height:32px;margin-top:10px;padding:8px 10px;border-radius:9px;background:rgba(85,200,255,.08);color:#b9d8ef;font-size:11px;font-weight:650}.pool-ph-cal-msg-061.ok{background:rgba(87,217,110,.11);color:#a9f2b6}.pool-ph-cal-msg-061.error{background:rgba(255,118,104,.12);color:#ffc1ba}
.pool-ph-cal-actions-061{display:flex;justify-content:flex-end;gap:10px;margin-top:13px}.pool-ph-cal-actions-061 button{height:42px;border-radius:10px;padding:0 17px;font-size:12px;font-weight:760;cursor:pointer}.pool-ph-cal-cancel-061{border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:#d8e6f3}.pool-ph-cal-save-061{border:0;background:linear-gradient(135deg,#278bd4,#25bfb5);color:#fff;box-shadow:0 8px 20px rgba(38,164,194,.25)}.pool-ph-cal-save-061:disabled{opacity:.62}
</style>
<div id="pool-ph-cal-modal-061" class="pool-ph-cal-modal-061" data-ph-cal-061="1" onclick="if(event.target===this){${close}}">
  <div class="pool-ph-cal-box-061" onclick="event.stopPropagation()">
    <div class="pool-ph-cal-title-061">PoolLab pH-Kalibrierung</div>
    <div class="pool-ph-cal-sub-061">Aktuellen PoolLab-Messwert eingeben</div>
    <input id="pool-ph-cal-input-061" class="pool-ph-cal-input-061" inputmode="decimal" autocomplete="off" placeholder="z. B. 7,06" onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('pool-ph-cal-save-061').click()}if(event.key==='Escape'){document.getElementById('pool-ph-cal-cancel-061').click()}">
    <div id="pool-ph-cal-msg-061" class="pool-ph-cal-msg-061">PoolLab-Wert eingeben und speichern.</div>
    <div class="pool-ph-cal-actions-061">
      <button id="pool-ph-cal-cancel-061" type="button" class="pool-ph-cal-cancel-061" onclick="${close}">Abbrechen</button>
      <button id="pool-ph-cal-save-061" type="button" class="pool-ph-cal-save-061" onclick="${save}">Speichern</button>
    </div>
  </div>
</div>`
  };
}

function patchIpadInput(htmlValue, namespace) {
  let html = patchVersion(htmlValue);
  if (!html) return html;

  const label = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = html.indexOf(label);
  if (labelIndex < 0) return html;

  const readingIndex = html.indexOf('<div class="metric-reading', labelIndex);
  if (readingIndex < 0) return html;
  const tagEnd = html.indexOf('>', readingIndex);
  if (tagEnd < 0) return html;

  const modal = buildIpadModal(namespace);
  const newTag = `<div class="metric-reading pool-ph-cal-open-061" title="PoolLab-Messwert erfassen" onclick="${modal.open}">`;
  html = html.slice(0, readingIndex) + newTag + html.slice(tagEnd + 1);

  if (!html.includes('data-ph-cal-061="1"')) html += modal.html;
  return html;
}

async function readPoints(adapter) {
  try {
    const state = await adapter.getStateAsync(POINTS_ID);
    return normalizePoints(JSON.parse(String((state && state.val) || '[]')));
  } catch {
    return [];
  }
}

async function harmonizeVersions(adapter) {
  for (const id of VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch {}
  }
}

function install(adapter) {
  if (!adapter || adapter.__phCaptureAndIpad061Installed) return adapter;
  adapter.__phCaptureAndIpad061Installed = true;

  adapter.__phDirectCapture060Running = true;
  adapter.__phCapture061Ready = false;
  adapter.__phCapture061Running = false;
  adapter.__phCapture061OwnWriteUntil = 0;
  adapter.__phCapture061LastEventTs = 0;
  adapter.__phCapture061Pending = null;

  async function patchIpadState() {
    const state = await adapter.getStateAsync(IPAD_ID);
    const current = String((state && state.val) || '');
    const next = patchIpadInput(current, adapter.namespace);
    if (!next || next === current) return;
    const writer = typeof adapter.__originalSetStateIfChanged056 === 'function'
      ? adapter.__originalSetStateIfChanged056.bind(adapter)
      : adapter.setStateIfChanged.bind(adapter);
    await writer(IPAD_ID, next, true);
  }

  async function capture(poollabValue, eventTs) {
    if (adapter.isShuttingDown) return;
    if (adapter.__phCapture061Running) {
      adapter.__phCapture061Pending = { value: poollabValue, ts: eventTs };
      return;
    }

    adapter.__phCapture061Running = true;
    try {
      const poollab = num(poollabValue);
      if (poollab === null || poollab < 0 || poollab > 14) throw new Error(`Ungültiger PoolLab-Wert: ${poollabValue}`);

      adapter.__phExplicitSaveAt = Date.now();
      if (adapter.__phAutoSaveTimer) {
        try { clearTimeout(adapter.__phAutoSaveTimer); } catch {}
        adapter.__phAutoSaveTimer = null;
      }

      const rawState = await adapter.getForeignStateAsync(RAW_ID);
      const raw = num(rawState && rawState.val);
      if (raw === null || raw < 0 || raw > 14) throw new Error('PH803-Rohwert ist nicht verfügbar oder ungültig');
      const rawAgeMs = rawState && (rawState.ts || rawState.lc)
        ? Math.max(0, Date.now() - Number(rawState.ts || rawState.lc))
        : 0;
      if (rawAgeMs > 10 * 60 * 1000) throw new Error(`PH803-Rohwert ist ${Math.round(rawAgeMs / 60000)} Minuten alt`);

      const existing = await readPoints(adapter);
      const replaced = existing.some(point => Math.abs(point.raw - raw) <= 0.02);
      const points = addPoint(existing, raw, poollab);
      const corrected = calculate(raw, points);
      if (corrected === null) throw new Error('Korrigierter pH konnte nicht berechnet werden');

      adapter.__phCapture061OwnWriteUntil = Date.now() + 1800;
      await adapter.setStateAsync(POOLLAB_ID, poollab, true);
      await adapter.setStateAsync(SAVE_TRIGGER_ID, Date.now(), true);
      await adapter.setStateAsync(POINTS_ID, JSON.stringify(points), true);

      const verifyState = await adapter.getStateAsync(POINTS_ID);
      const verified = normalizePoints(JSON.parse(String((verifyState && verifyState.val) || '[]')));
      const stored = verified.some(point => Math.abs(point.raw - raw) <= 0.001 && Math.abs(point.ref - poollab) <= 0.001);
      if (!stored) throw new Error('Kalibrierpunkt wurde nicht in pointsJson bestätigt');

      await adapter.setStateIfChanged('status.phCalibration.count', verified.length, true);
      await adapter.setStateIfChanged('status.phCalibration.lastPoollab', rnd(poollab), true);
      await adapter.setStateIfChanged('status.phCalibration.lastRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.lastSavedTs', Date.now(), true);
      await adapter.setStateIfChanged('status.phCalibration.currentRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.currentCorrected', corrected, true);
      await adapter.setStateIfChanged('status.phCalibration.currentDelta', rnd(corrected - raw), true);
      await adapter.setForeignStateAsync(OUT_ID, corrected, true);

      adapter.__phCalibrationPoints = verified;
      adapter.__phCentral059Raw = raw;
      adapter.__phCentral059Corrected = corrected;
      adapter.__phCentral059LastDisplayWrite = 0;
      adapter.__phPolling057LastRaw = null;
      adapter.__phPolling057LastCorrected = null;

      const delta = rnd(poollab - raw);
      const message = `${replaced ? 'Kalibrierpunkt aktualisiert' : 'Kalibrierpunkt gespeichert'}: PH803 ${fmt(raw)} → PoolLab ${fmt(poollab)} (${delta >= 0 ? '+' : ''}${fmt(delta)}). JSON bestätigt.`;
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', message, true);

      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      if (Object.prototype.hasOwnProperty.call(adapter, '__ipadLastFullRender056')) adapter.__ipadLastFullRender056 = 0;
      try { await adapter.forceImmediateRender(); } catch {}
      try { await patchIpadState(); } catch {}

      if (adapter.log && typeof adapter.log.info === 'function') adapter.log.info(`[PH-KAL] ${VERSION}: ${message}`);
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', `Kalibrierung fehlgeschlagen: ${text}`, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', true, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', `Kalibrierung fehlgeschlagen: ${text}`, true);
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
        adapter.log.error('[PH-KAL] Direkte PoolLab-Erfassung 0.4.61 fehlgeschlagen: ' + text);
      }
    } finally {
      adapter.__phCapture061Running = false;
      const pending = adapter.__phCapture061Pending;
      adapter.__phCapture061Pending = null;
      if (pending && !adapter.isShuttingDown) capture(pending.value, pending.ts).catch(() => {});
    }
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      try { await patchIpadState(); } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
          adapter.log.warn('[PH-KAL] iPad-Mini-Eingabe 0.4.61 konnte nicht ergänzt werden: ' + (error.message || error));
        }
      }
      await harmonizeVersions(adapter);
      return result;
    };
  }

  adapter.on('ready', () => {
    try { adapter.subscribeStates(POOLLAB_ID); } catch {}
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        const current = await adapter.getStateAsync(POOLLAB_ID);
        adapter.__phCapture061LastEventTs = Number(current && current.ts) || Date.now();
        adapter.__phCapture061Ready = true;
        await patchIpadState();
        if (adapter.log && typeof adapter.log.info === 'function') {
          adapter.log.info(`[PH-KAL] ${VERSION}: iPad-Eingabe aktiv; PoolLab-Erfassung schreibt und prüft pointsJson direkt`);
        }
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
          adapter.log.warn('[PH-KAL] Initialisierung 0.4.61 fehlgeschlagen: ' + (error.message || error));
        }
      }
    }, 3500));
  });

  adapter.on('stateChange', (id, state) => {
    if (id !== `${adapter.namespace}.${POOLLAB_ID}` || !state || adapter.isShuttingDown) return;
    const eventTs = Number(state.ts) || Date.now();
    if (!adapter.__phCapture061Ready) {
      adapter.__phCapture061LastEventTs = Math.max(adapter.__phCapture061LastEventTs, eventTs);
      return;
    }
    if (Date.now() <= adapter.__phCapture061OwnWriteUntil) {
      adapter.__phCapture061LastEventTs = Math.max(adapter.__phCapture061LastEventTs, eventTs);
      return;
    }
    if (eventTs <= adapter.__phCapture061LastEventTs) return;
    adapter.__phCapture061LastEventTs = eventTs;
    capture(state.val, eventTs).catch(() => {});
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

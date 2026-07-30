'use strict';

const createBase = require('./main-ipadmini-final-061.js');

const VERSION = 'v0.4.62';
const RAW_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const OUT_ID = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value_korr';
const POOLLAB_ID = 'control.ph.calibration.poollabValue';
const CAPTURE_ID = 'control.ph.calibration.captureRequest';
const EDIT_ID = 'control.ph.calibration.ipadMiniEditing';
const POINTS_ID = 'status.phCalibration.pointsJson';
const RESULT_ID = 'status.phCalibration.captureResult';
const LAST_REQUEST_ID = 'status.phCalibration.lastCaptureRequestId';
const IPAD_ID = 'vis.htmlIpadMini';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', IPAD_ID];
const POLL_MS = 1000;

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

function addPoint(pointsValue, rawValue, refValue, ts = Date.now()) {
  const points = normalizePoints(pointsValue);
  const raw = rnd(rawValue);
  const ref = rnd(refValue);
  const next = { raw, ref, delta: rnd(ref - raw), ts: Number(ts) || Date.now() };
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
    return rnd(raw + left.delta + ((right.delta - left.delta) * factor));
  }
  return rnd(raw + last.delta);
}

function validatePoints(pointsValue) {
  const points = normalizePoints(pointsValue);
  if (!points.length) return { ok: false, reason: 'Kein gültiger PoolLab-Kalibrierpunkt vorhanden', points };
  for (const point of points) {
    if (Math.abs(point.delta) > 0.60) {
      return { ok: false, reason: `Unplausibles Kalibrierdelta ${point.delta.toFixed(3)}`, points };
    }
  }
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1];
    const right = points[index];
    const rawGap = right.raw - left.raw;
    if (rawGap < 0.05) continue;
    const slope = (right.ref - left.ref) / rawGap;
    if (slope < 0.35 || slope > 1.65) {
      return { ok: false, reason: `Unplausible Kennlinie ${left.raw.toFixed(2)} bis ${right.raw.toFixed(2)}`, points };
    }
  }
  return { ok: true, reason: '', points };
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

function fullId(namespace, relativeId) {
  return `${String(namespace || 'poolsteuerung.0')}.${relativeId}`
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function buildRequestSaveHandler(namespace, ids) {
  const captureId = fullId(namespace, CAPTURE_ID);
  const editId = fullId(namespace, EDIT_ID);
  return escapeAttribute([
    'event.preventDefault()',
    'event.stopPropagation()',
    'var b=this',
    `var i=document.getElementById('${ids.input}')`,
    `var m=document.getElementById('${ids.modal}')`,
    `var t=document.getElementById('${ids.message}')`,
    "var x=Number(String(i&&i.value||'').trim().replace(',','.'))",
    "if(!Number.isFinite(x)||x<0||x>14){if(t){t.textContent='Bitte einen gültigen pH-Wert eingeben.';t.className=t.className+' error'};if(i)i.focus();return false}",
    "var v=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    "if(!v){if(t)t.textContent='VIS-Verbindung nicht verfügbar.';return false}",
    "function w(id,val){if(typeof v.setValue==='function')return Promise.resolve(v.setValue(id,val));if(v.conn&&typeof v.conn.setState==='function')return Promise.resolve(v.conn.setState(id,val));return Promise.reject(new Error('setState nicht verfügbar'))}",
    "var now=Date.now(),req=JSON.stringify({poollab:x,ts:now,nonce:String(now)+'-'+Math.random().toString(36).slice(2)})",
    "b.disabled=true;b.textContent='Speichere …'",
    `w('${captureId}',req).then(function(){if(t){t.textContent='Messwert übertragen – JSON wird geprüft.';t.className=t.className.replace(' error','')+' ok'};b.textContent='Übertragen';setTimeout(function(){w('${editId}',false);if(m)m.style.display='none';b.disabled=false;b.textContent='Speichern'},1400)},function(){if(t){t.textContent='Übertragung fehlgeschlagen.';t.className=t.className+' error'};b.disabled=false;b.textContent='Speichern'})`,
    'return false'
  ].join(';'));
}

function buildIpadUi(namespace) {
  const ids = {
    modal: 'pool-ph-cal-modal-062',
    input: 'pool-ph-cal-input-062',
    message: 'pool-ph-cal-msg-062'
  };
  const save = buildRequestSaveHandler(namespace, ids);
  const editOnId = fullId(namespace, EDIT_ID);
  const editOffId = fullId(namespace, EDIT_ID);
  const open = escapeAttribute([
    'event.preventDefault()',
    'event.stopPropagation()',
    `var m=document.getElementById('${ids.modal}'),i=document.getElementById('${ids.input}'),t=document.getElementById('${ids.message}')`,
    "var v=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    "function w(id,val){if(!v)return;if(typeof v.setValue==='function')v.setValue(id,val);else if(v.conn&&typeof v.conn.setState==='function')v.conn.setState(id,val)}",
    "if(t){t.textContent='PoolLab-Wert eingeben und speichern.';t.className='pool-ph-cal-msg-062'}",
    "if(i)i.value=''",
    "if(m)m.style.display='flex'",
    `w('${editOnId}',true)`,
    'setTimeout(function(){if(i)i.focus()},50)',
    'return false'
  ].join(';'));
  const close = escapeAttribute([
    'event.preventDefault()',
    'event.stopPropagation()',
    `var m=document.getElementById('${ids.modal}')`,
    "var v=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    "if(m)m.style.display='none'",
    `if(v){if(typeof v.setValue==='function')v.setValue('${editOffId}',false);else if(v.conn&&typeof v.conn.setState==='function')v.conn.setState('${editOffId}',false)}`,
    'return false'
  ].join(';'));

  return {
    button: `<button type="button" class="pool-ph-cal-open-062" data-ph-cal-open-062="1" onclick="${open}">PoolLab</button>`,
    modal: `<style data-ph-cal-ui-062="1">
.pool-ph-cal-open-062{position:absolute;right:14px;top:70px;z-index:8;height:27px;padding:0 11px;border:1px solid rgba(85,200,255,.35);border-radius:999px;background:rgba(30,105,150,.24);color:#9de1ff;font:750 10px/1 "Segoe UI Variable","Segoe UI",Arial,sans-serif;cursor:pointer}
.pool-ph-cal-open-062:active{transform:scale(.97)}
.pool-ph-cal-modal-062{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(2,8,18,.78);backdrop-filter:blur(5px)}
.pool-ph-cal-box-062{width:min(390px,92vw);padding:19px;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:linear-gradient(155deg,#173457,#081827);box-shadow:0 24px 65px rgba(0,0,0,.5);color:#fff;font-family:"Segoe UI Variable","Segoe UI",Arial,sans-serif}
.pool-ph-cal-title-062{font-size:20px;font-weight:760}.pool-ph-cal-sub-062{margin-top:3px;color:#a9bdd2;font-size:12px}
.pool-ph-cal-input-062{width:100%;height:58px;margin-top:15px;border:1px solid rgba(85,200,255,.5);border-radius:12px;background:#061522;color:#fff;padding:6px 12px;font-size:28px;font-weight:760;outline:none}
.pool-ph-cal-msg-062{min-height:32px;margin-top:10px;padding:8px 10px;border-radius:9px;background:rgba(85,200,255,.08);color:#b9d8ef;font-size:11px;font-weight:650}.pool-ph-cal-msg-062.ok{background:rgba(87,217,110,.11);color:#a9f2b6}.pool-ph-cal-msg-062.error{background:rgba(255,118,104,.12);color:#ffc1ba}
.pool-ph-cal-actions-062{display:flex;justify-content:flex-end;gap:10px;margin-top:13px}.pool-ph-cal-actions-062 button{height:42px;border-radius:10px;padding:0 17px;font-size:12px;font-weight:760;cursor:pointer}.pool-ph-cal-cancel-062{border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:#d8e6f3}.pool-ph-cal-save-062{border:0;background:linear-gradient(135deg,#278bd4,#25bfb5);color:#fff}.pool-ph-cal-save-062:disabled{opacity:.62}
</style>
<div id="${ids.modal}" class="pool-ph-cal-modal-062" data-ph-cal-ui-062="1" onclick="if(event.target===this){document.getElementById('pool-ph-cal-cancel-062').click()}">
  <div class="pool-ph-cal-box-062" onclick="event.stopPropagation()">
    <div class="pool-ph-cal-title-062">PoolLab pH-Kalibrierung</div>
    <div class="pool-ph-cal-sub-062">Aktuellen PoolLab-Messwert erfassen</div>
    <input id="${ids.input}" class="pool-ph-cal-input-062" inputmode="decimal" autocomplete="off" placeholder="z. B. 7,06" onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('pool-ph-cal-save-062').click()}if(event.key==='Escape'){document.getElementById('pool-ph-cal-cancel-062').click()}">
    <div id="${ids.message}" class="pool-ph-cal-msg-062">PoolLab-Wert eingeben und speichern.</div>
    <div class="pool-ph-cal-actions-062">
      <button id="pool-ph-cal-cancel-062" type="button" class="pool-ph-cal-cancel-062" onclick="${close}">Abbrechen</button>
      <button id="pool-ph-cal-save-062" type="button" class="pool-ph-cal-save-062" onclick="${save}">Speichern</button>
    </div>
  </div>
</div>`
  };
}

function patchLegacyModalHandler(htmlValue, namespace) {
  let html = patchVersion(htmlValue);
  if (!html) return html;
  const ids = { modal: 'pool-ph-cal-modal', input: 'pool-ph-cal-input', message: 'pool-ph-cal-msg' };
  const save = buildRequestSaveHandler(namespace, ids);
  html = html.replace(/<button id="pool-ph-cal-save"[^>]*>Speichern<\/button>/g,
    `<button id="pool-ph-cal-save" type="button" class="pool-ph-cal-save" onclick="${save}">Speichern</button>`);
  return html;
}

function patchIpad(htmlValue, namespace) {
  let html = patchLegacyModalHandler(htmlValue, namespace);
  if (!html) return html;
  const label = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = html.indexOf(label);
  if (labelIndex < 0) return html;
  const sectionStart = html.lastIndexOf('<section', labelIndex);
  const sectionEnd = html.indexOf('</section>', labelIndex);
  if (sectionStart < 0 || sectionEnd < 0) return html;
  const ui = buildIpadUi(namespace);
  let section = html.slice(sectionStart, sectionEnd);
  if (!section.includes('data-ph-cal-open-062="1"')) section = section.replace(label, `${label}${ui.button}`);
  html = html.slice(0, sectionStart) + section + html.slice(sectionEnd);
  if (!html.includes('data-ph-cal-ui-062="1"')) html += ui.modal;
  return html;
}

async function ensureState(adapter, id, common, def) {
  await adapter.setObjectNotExistsAsync(id, { type: 'state', common: { ...common, def }, native: {} });
  const state = await adapter.getStateAsync(id);
  if (!state) await adapter.setStateAsync(id, def, true);
}

async function readPoints(adapter) {
  try {
    const state = await adapter.getStateAsync(POINTS_ID);
    return normalizePoints(JSON.parse(String((state && state.val) || '[]')));
  } catch {
    return [];
  }
}

function parseRequest(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;
    const poollab = num(parsed.poollab);
    const ts = Number(parsed.ts);
    const nonce = String(parsed.nonce || '');
    if (poollab === null || poollab < 0 || poollab > 14 || !Number.isFinite(ts) || !nonce) return null;
    return { poollab, ts, nonce, id: `${ts}:${nonce}` };
  } catch {
    return null;
  }
}

function install(adapter) {
  if (!adapter || adapter.__phCaptureRequest062Installed) return adapter;
  adapter.__phCaptureRequest062Installed = true;
  adapter.__phCapture062Initialized = false;
  adapter.__phCapture062Processing = false;
  adapter.__phCapture062PollTimer = null;
  adapter.__phCapture062LastRequestId = '';

  async function patchVisStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = id === IPAD_ID ? patchIpad(current, adapter.namespace) : patchLegacyModalHandler(current, adapter.namespace);
        if (!next || next === current) continue;
        const writer = id === IPAD_ID && typeof adapter.__originalSetStateIfChanged056 === 'function'
          ? adapter.__originalSetStateIfChanged056.bind(adapter)
          : adapter.setStateIfChanged.bind(adapter);
        await writer(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.debug === 'function') {
          adapter.log.debug(`[PH-KAL] VIS-Patch 0.4.62 für ${id} fehlgeschlagen: ${error.message || error}`);
        }
      }
    }
  }

  async function processRequest(request) {
    if (adapter.__phCapture062Processing || adapter.isShuttingDown) return;
    adapter.__phCapture062Processing = true;
    try {
      const rawState = await adapter.getForeignStateAsync(RAW_ID);
      const raw = num(rawState && rawState.val);
      if (raw === null || raw < 0 || raw > 14) throw new Error('PH803-Rohwert ist nicht verfügbar oder ungültig');
      const rawAgeMs = rawState && (rawState.ts || rawState.lc)
        ? Math.max(0, Date.now() - Number(rawState.ts || rawState.lc))
        : 0;
      if (rawAgeMs > 10 * 60 * 1000) throw new Error(`PH803-Rohwert ist ${Math.round(rawAgeMs / 60000)} Minuten alt`);

      const existing = await readPoints(adapter);
      const replaced = existing.some(point => Math.abs(point.raw - raw) <= 0.02);
      const points = addPoint(existing, raw, request.poollab, request.ts);
      const corrected = calculate(raw, points);
      if (corrected === null) throw new Error('Korrigierter pH konnte nicht berechnet werden');

      adapter.__phCapture061OwnWriteUntil = Date.now() + 2500;
      adapter.__phCapture061LastEventTs = Math.max(Number(adapter.__phCapture061LastEventTs) || 0, Date.now());
      await adapter.setStateAsync(POINTS_ID, JSON.stringify(points), true);

      const verifyState = await adapter.getStateAsync(POINTS_ID);
      const verified = normalizePoints(JSON.parse(String((verifyState && verifyState.val) || '[]')));
      const stored = verified.some(point => Math.abs(point.raw - raw) <= 0.001 && Math.abs(point.ref - request.poollab) <= 0.001);
      if (!stored) throw new Error('Kalibrierpunkt wurde nach dem Schreiben nicht in pointsJson gefunden');

      const validation = validatePoints(verified);
      await adapter.setStateAsync(POOLLAB_ID, request.poollab, true);
      await adapter.setStateIfChanged('status.phCalibration.count', verified.length, true);
      await adapter.setStateIfChanged('status.phCalibration.initialized', true, true);
      await adapter.setStateIfChanged('status.phCalibration.lastPoollab', rnd(request.poollab), true);
      await adapter.setStateIfChanged('status.phCalibration.lastRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.lastSavedTs', Date.now(), true);
      await adapter.setStateIfChanged('status.phCalibration.currentRaw', rnd(raw), true);
      await adapter.setStateIfChanged('status.phCalibration.currentCorrected', corrected, true);
      await adapter.setStateIfChanged('status.phCalibration.currentDelta', rnd(corrected - raw), true);
      await adapter.setForeignStateAsync(OUT_ID, corrected, true);
      await adapter.setStateIfChanged(LAST_REQUEST_ID, request.id, true);
      adapter.__phCapture062LastRequestId = request.id;

      const delta = rnd(request.poollab - raw);
      const message = `${replaced ? 'Kalibrierpunkt aktualisiert' : 'Kalibrierpunkt gespeichert'}: PH803 ${fmt(raw)} → PoolLab ${fmt(request.poollab)} (${delta >= 0 ? '+' : ''}${fmt(delta)}). JSON bestätigt.`;
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', message, true);
      await adapter.setStateIfChanged(RESULT_ID, message, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', !validation.ok, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', validation.ok ? '' : validation.reason, true);

      adapter.__phCalibrationPoints = verified;
      adapter.__phCentral059Raw = raw;
      adapter.__phCentral059Corrected = corrected;
      adapter.__phCentral059LastDisplayWrite = 0;
      adapter.__phPolling057LastRaw = null;
      adapter.__phPolling057LastCorrected = null;
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      if (Object.prototype.hasOwnProperty.call(adapter, '__ipadLastFullRender056')) adapter.__ipadLastFullRender056 = 0;
      try { await adapter.forceImmediateRender(); } catch {}
      await patchVisStates();

      if (adapter.log && typeof adapter.log.info === 'function') adapter.log.info(`[PH-KAL] ${VERSION}: ${message}`);
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      await adapter.setStateIfChanged(RESULT_ID, `Fehler: ${text}`, true);
      await adapter.setStateIfChanged('status.phCalibration.lastMessage', `Kalibrierung fehlgeschlagen: ${text}`, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', true, true);
      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', `Kalibrierung fehlgeschlagen: ${text}`, true);
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.error === 'function') {
        adapter.log.error('[PH-KAL] Capture-Request 0.4.62 fehlgeschlagen: ' + text);
      }
    } finally {
      adapter.__phCapture062Processing = false;
    }
  }

  async function pollRequest() {
    if (adapter.isShuttingDown || !adapter.__phCapture062Initialized) return;
    try {
      const state = await adapter.getStateAsync(CAPTURE_ID);
      const request = parseRequest(state && state.val);
      if (request && request.id !== adapter.__phCapture062LastRequestId) await processRequest(request);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn('[PH-KAL] Capture-Request konnte nicht gelesen werden: ' + (error.message || error));
      }
    }
  }

  function schedulePoll() {
    if (adapter.isShuttingDown || adapter.__phCapture062PollTimer) return;
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      adapter.__phCapture062PollTimer = null;
      await pollRequest();
      schedulePoll();
    }, POLL_MS));
    adapter.__phCapture062PollTimer = handle;
  }

  async function initialize() {
    if (adapter.__phCapture062Initialized || adapter.isShuttingDown) return;
    await ensureState(adapter, CAPTURE_ID, { name: 'PoolLab-Erfassungsauftrag', type: 'string', role: 'json', read: true, write: true }, '');
    await ensureState(adapter, RESULT_ID, { name: 'Ergebnis der PoolLab-Erfassung', type: 'string', role: 'text', read: true, write: false }, 'Noch keine Erfassung');
    await ensureState(adapter, LAST_REQUEST_ID, { name: 'Letzter verarbeiteter PoolLab-Auftrag', type: 'string', role: 'text', read: true, write: false }, '');
    try {
      await adapter.extendObjectAsync(POINTS_ID, {
        common: { name: 'Kalibrierpunkte', type: 'string', role: 'json', read: true, write: true }
      });
    } catch {}
    const last = await adapter.getStateAsync(LAST_REQUEST_ID);
    adapter.__phCapture062LastRequestId = String((last && last.val) || '');
    adapter.__phCapture062Initialized = true;
    await patchVisStates();
    schedulePoll();
    if (adapter.log && typeof adapter.log.info === 'function') {
      adapter.log.info(`[PH-KAL] ${VERSION}: Capture-Request aktiv; pointsJson ist manuell editierbar`);
    }
  }

  function scheduleInitialize(delay) {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown || adapter.__phCapture062Initialized) return;
      try { await initialize(); }
      catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
          adapter.log.warn(`[PH-KAL] Initialisierung 0.4.62 nach ${delay} ms fehlgeschlagen: ${error.message || error}`);
        }
      }
    }, delay));
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchLegacyModalHandler(original({ ...(data || {}), adapterVersion: VERSION }), adapter.namespace);
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchVisStates();
      return result;
    };
  }

  adapter.on('ready', () => scheduleInitialize(300));
  for (const delay of [800, 2500, 7000]) scheduleInitialize(delay);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

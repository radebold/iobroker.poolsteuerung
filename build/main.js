'use strict';
const utils = require('@iobroker/adapter-core');

function parseNum(v) {
  if (v === undefined || v === null || v === '') return 0;
  return Number(String(v).replace(',', '.'));
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class Poolsteuerung extends utils.Adapter {

  lastTabletWidget = '';
  lastPhoneWidget = '';
  lastSlowUpdate = 0;
  lastRenderSignature = '';
  lastRenderAt = 0;
  lastPumpScheduleActiveMemory = null;
  suppressOwnPumpLogUntil = 0;
  alertLockMemory = {};
  lastCirculationPumpOn = false;
  circulationPumpStartedAt = 0;

  constructor(options = {}) {
    super({ ...options, name: 'poolsteuerung' });
    this.timer = null;
    this.monitoredIds = [];
    this.renderQueued = false;
    this.lastWrittenPhStopAtTs = null;
    this.phDoseStopAtTsMemory = 0;
    this.phLastDoseTsMemory = 0;
    this.phLastDoseDurationSecMemory = 0;
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  debug(msg) {
    if (this.config.debugMode) this.log.debug('[DEBUG] ' + msg);
  }

  async ensureState(id, type, role, def, write = false) {
    await this.setObjectNotExistsAsync(id, {
      type: 'state',
      common: { name: id, type, role, read: true, write, def },
      native: {}
    });
    if (!write && def !== undefined) {
      const cur = await this.getStateAsync(id);
      if (!cur || cur.val === null || cur.val === undefined || cur.val === '') {
        await this.setStateAsync(id, def, true);
      }
    }
  }

  async setStateIfChanged(id, value, ack = true) {
    const cur = await this.getStateAsync(id);
    const curVal = cur ? cur.val : undefined;
    if (curVal === value) return false;
    await this.setStateAsync(id, value, ack);
    return true;
  }

  formatDateTimeShort(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    const today = new Date();
    const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    const prefix = sameDay ? 'heute' : 'morgen';
    return `${prefix} um ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  nextOccurrenceForHHMM(hhmm, now = new Date()) {
    const mins = this.parseHHMM(hhmm);
    if (mins === null) return null;
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  getPumpWindows() {
    return [
      { start: this.config.pumpWindow1Start, end: this.config.pumpWindow1End },
      { start: this.config.pumpWindow2Start, end: this.config.pumpWindow2End }
    ].filter(w => this.parseHHMM(w.start) !== null && this.parseHHMM(w.end) !== null && this.parseHHMM(w.start) !== this.parseHHMM(w.end) && !(this.parseHHMM(w.start) === 0 && this.parseHHMM(w.end) === 0));
  }

  getNextPumpAction(now = new Date()) {
    const windows = this.getPumpWindows();
    if (!windows.length) return null;
    const candidates = [];
    for (const w of windows) {
      const start = this.nextOccurrenceForHHMM(w.start, now);
      const end = this.nextOccurrenceForHHMM(w.end, now);
      if (start) candidates.push({ when: start, action: 'EIN', reason: `Zeitfenster ${w.start}-${w.end}` });
      if (end) candidates.push({ when: end, action: 'AUS', reason: `Zeitfenster ${w.start}-${w.end}` });
    }
    candidates.sort((a, b) => a.when - b.when);
    return candidates[0] || null;
  }

  getNextPhCheck(now = new Date()) {
    const list = String(this.config.phCheckTimes || '').split(',').map(v => v.trim()).filter(Boolean).map(v => this.nextOccurrenceForHHMM(v, now)).filter(Boolean);
    list.sort((a, b) => a - b);
    return list[0] || null;
  }

  getNextChlorCheck(now = new Date()) {
    const pollMin = Math.max(1, Number(this.config.pollIntervalMin) || 1);
    return new Date(now.getTime() + pollMin * 60000);
  }

  async logStartupSummary() {
    const now = new Date();
    const pumpCurrent = this.config.circulationPumpSocketStateId ? await this.getBool(this.config.circulationPumpSocketStateId) : false;
    const pumpNext = this.getNextPumpAction(now);
    const phNext = this.getNextPhCheck(now);
    const chlorNext = this.getNextChlorCheck(now);
    const phValue = await this.getNumber(this.config.phStateId, 2);
    const orpValue = await this.getNumber(this.config.orpStateId, 0);
    this.log.info('===== PoolSteuerung Start-Zusammenfassung =====');
    if (this.config.standbyModeEnabled === true) {
      const standbyNext = this.getNextStandbyRun(now);
      this.log.info(`Modus: STANDBY | Umwälzpumpe nur 1x täglich ${Math.max(1, parseNum(this.config.standbyPumpDurationSec || 30))}s | Nächster Kurzlauf: ${standbyNext ? this.formatDateTimeShort(standbyNext) : 'ungültige Uhrzeit'}`);
    }
    if (this.config.enableCirculationControl === false) {
      this.log.info(`Umwälzpumpe: Steuerung deaktiviert | Status jetzt: ${pumpCurrent ? 'EIN' : 'AUS'}`);
    } else if (pumpNext) {
      this.log.info(`Umwälzpumpe: Status jetzt ${pumpCurrent ? 'EIN' : 'AUS'} | Nächste Aktion: ${pumpNext.action} ${this.formatDateTimeShort(pumpNext.when)} | ${pumpNext.reason}`);
    } else {
      this.log.info(`Umwälzpumpe: Status jetzt ${pumpCurrent ? 'EIN' : 'AUS'} | Keine nächste Aktion konfiguriert`);
    }
    if (this.config.enableChlorControl === false) {
      this.log.info('Chlor-Steuerung: deaktiviert');
    } else {
      this.log.info(`Chlor-Steuerung: nächste Prüfung ${this.formatDateTimeShort(chlorNext)} | ORP aktuell: ${Number.isFinite(orpValue) ? orpValue : '--'} | Grenzen: EIN <= ${parseNum(this.config.orpOnThreshold || 725)} / AUS > ${parseNum(this.config.orpOffThreshold || 750)} | Verzögerung nach Pumpenstart: ${Math.max(0, parseNum(this.config.chlorPumpStartDelaySec || 0))}s`);
    }
    if (this.config.enablePhControl === false) {
      this.log.info('pH-Steuerung: deaktiviert');
    } else if (phNext) {
      this.log.info(`pH-Steuerung: nächste Prüfung ${this.formatDateTimeShort(phNext)} | pH aktuell: ${Number.isFinite(phValue) ? phValue.toFixed(2) : '--'} | Soll: ${parseNum(this.config.phSetpoint || 7.2).toFixed(2)} + Tol. ${parseNum(this.config.phDoseTolerance || 0.05).toFixed(2)}`);
    } else {
      this.log.info(`pH-Steuerung: keine Prüfzeiten konfiguriert | pH aktuell: ${Number.isFinite(phValue) ? phValue.toFixed(2) : '--'}`);
    }
    await this.runHeartbeatChecks();
    this.log.info('================================================');
  }

  calcVolume() {
    const d = parseNum(this.config.poolDiameterM);
    const h = parseNum(this.config.poolWaterHeightM);
    if (!d || !h) return 0;
    return Number((Math.PI * Math.pow(d / 2, 2) * h).toFixed(2));
  }

  async getNumber(id, digits = null) {
    if (!id) return null;
    try {
      const s = await this.getForeignStateAsync(id);
      const n = Number(String(s && s.val).replace(',', '.'));
      if (!Number.isFinite(n)) return null;
      return digits === null ? n : Number(n.toFixed(digits));
    } catch {
      return null;
    }
  }

  async getBool(id) {
    if (!id) return false;
    try {
      const s = await this.getForeignStateAsync(id);
      return !!(s && s.val);
    } catch {
      return false;
    }
  }

  async getStateSnapshot(id) {
    if (!id) return null;
    try {
      return await this.getForeignStateAsync(id);
    } catch {
      return null;
    }
  }

  updateCirculationPumpRuntime(isOn, stateTs = 0) {
    const active = !!isOn;
    const ts = Number(stateTs) || Date.now();

    if (active) {
      if (!this.lastCirculationPumpOn) {
        this.circulationPumpStartedAt = ts;
      } else if (!this.circulationPumpStartedAt) {
        this.circulationPumpStartedAt = ts;
      }
    } else {
      this.circulationPumpStartedAt = 0;
    }

    this.lastCirculationPumpOn = active;
  }

  getPumpOnForSec(nowTs = Date.now()) {
    if (!this.lastCirculationPumpOn || !this.circulationPumpStartedAt) return 0;
    return Math.max(0, Math.floor((nowTs - this.circulationPumpStartedAt) / 1000));
  }



  async evaluateHeartbeat(label, stateId, maxAgeMin) {
    const result = {
      ok: true,
      severity: 'ok',
      text: `${label}: keine Heartbeat-Prüfung`,
      ageMin: null,
      stateId: stateId || ''
    };
    const maxAge = Math.max(0, Number(maxAgeMin) || 0);
    if (!stateId || maxAge <= 0) return result;

    try {
      const obj = await this.getForeignObjectAsync(stateId);
      if (!obj || !obj.common) {
        return { ok: false, severity: 'error', text: `${label}: Heartbeat-State nicht gefunden`, ageMin: null, stateId };
      }
      const st = await this.getForeignStateAsync(stateId);
      if (!st) {
        return { ok: false, severity: 'error', text: `${label}: Heartbeat-State nicht lesbar`, ageMin: null, stateId };
      }
      const refTs = Number(st.ts || st.lc || 0);
      if (!refTs) {
        return { ok: false, severity: 'warn', text: `${label}: Heartbeat ohne Zeitstempel`, ageMin: null, stateId };
      }
      const ageMin = Math.floor((Date.now() - refTs) / 60000);
      if (ageMin > maxAge) {
        return {
          ok: false,
          severity: 'warn',
          text: `${label}: WARNUNG | letzte Meldung vor ${ageMin} min`,
          ageMin,
          stateId
        };
      }
      return {
        ok: true,
        severity: 'ok',
        text: `${label}: OK | letzte Meldung vor ${ageMin} min`,
        ageMin,
        stateId
      };
    } catch (e) {
      return { ok: false, severity: 'error', text: `${label}: Prüffehler | ${e.message || e}`, ageMin: null, stateId };
    }
  }

  async runHeartbeatChecks() {
    const checks = [
      ['Umwälzpumpe', this.config.circulationPumpHeartbeatStateId, this.config.circulationPumpHeartbeatMaxAgeMin, 'status.checks.circulationPump'],
      ['Chlorinator', this.config.chlorinatorHeartbeatStateId, this.config.chlorinatorHeartbeatMaxAgeMin, 'status.checks.chlorinator'],
      ['pH-Dosierpumpe', this.config.phPumpHeartbeatStateId, this.config.phPumpHeartbeatMaxAgeMin, 'status.checks.phPump'],
      ['Wärmepumpe', this.config.heatpumpHeartbeatStateId, this.config.heatpumpHeartbeatMaxAgeMin, 'status.checks.heatpump']
    ];

    for (const [label, stateId, maxAgeMin, targetId] of checks) {
      await this.ensureState(targetId, 'string', 'text', '', false);
      const result = await this.evaluateHeartbeat(label, stateId, maxAgeMin);
      await this.setStateIfChanged(targetId, result.text, true);
      if (stateId && (Number(maxAgeMin) || 0) > 0) {
        if (result.severity === 'error') this.log.warn(`[CHECK] ${result.text}`);
        else if (result.severity === 'warn') this.log.warn(`[CHECK] ${result.text}`);
        else this.log.info(`[CHECK] ${result.text}`);
      }
    }
  }

  async getHeartbeatOk(targetId) {
    if (!targetId) return true;
    try {
      const s = await this.getStateAsync(targetId);
      const text = String((s && s.val) || '').trim();
      if (!text) return true;
      if (text.includes('keine Heartbeat-Prüfung')) return true;
      return text.includes(': OK |');
    } catch {
      return true;
    }
  }

  async setSwitchStateCompat(id, on) {
    if (!id) return;

    let mode = '';
    if (id === this.config.circulationPumpSocketStateId) mode = this.config.circulationPumpWriteMode || '';
    if (id === this.config.chlorinatorSocketStateId) mode = this.config.chlorinatorWriteMode || '';
    if (id === this.config.phPumpSocketStateId) mode = this.config.phPumpWriteMode || '';

    const obj = await this.getForeignObjectAsync(id);
    const common = obj && obj.common ? obj.common : {};
    let value;

    if (mode === 'num01') {
      value = on ? 1 : 0;
    } else if (mode === 'bool') {
      value = !!on;
    } else if (common.type === 'number') {
      value = on ? 1 : 0;
    } else if (common.type === 'string') {
      const states = common.states || {};
      const entries = Object.entries(states).map(([k, v]) => [String(k), String(v).toLowerCase()]);
      const onEntry = entries.find(([k, v]) => k === '1' || v === 'on' || v === 'ein' || v === 'true');
      const offEntry = entries.find(([k, v]) => k === '0' || v === 'off' || v === 'aus' || v === 'false');
      value = on ? (onEntry ? onEntry[0] : '1') : (offEntry ? offEntry[0] : '0');
    } else {
      value = !!on;
    }

    await this.setForeignStateAsync(id, value, false);
  }


  async forceSwitchOnCompat(id) {
    if (!id) return false;
    const attempts = [
      async () => this.setSwitchStateCompat(id, true),
      async () => this.setForeignStateAsync(id, true, false),
      async () => this.setForeignStateAsync(id, 1, false),
      async () => this.setForeignStateAsync(id, '1', false),
    ];
    for (const attempt of attempts) {
      try { await attempt(); } catch {}
      try {
        await new Promise(resolve => setTimeout(resolve, 350));
        const current = await this.getBool(id);
        if (current) return true;
      } catch {}
    }
    return false;
  }

  async forceSwitchOffCompat(id) {
    if (!id) return false;
    const attempts = [
      async () => this.setSwitchStateCompat(id, false),
      async () => this.setForeignStateAsync(id, false, false),
      async () => this.setForeignStateAsync(id, 0, false),
      async () => this.setForeignStateAsync(id, '0', false),
    ];
    for (const attempt of attempts) {
      try { await attempt(); } catch {}
      try {
        await new Promise(resolve => setTimeout(resolve, 350));
        const current = await this.getBool(id);
        if (!current) return true;
      } catch {}
    }
    return false;
  }

  async getText(id, fallback = '--') {
    if (!id) return fallback;
    try {
      const s = await this.getForeignStateAsync(id);
      return s && s.val !== undefined && s.val !== null && s.val !== '' ? String(s.val) : fallback;
    } catch {
      return fallback;
    }
  }

  fmt(n, digits = 1, fallback = '--') {
    return n === null || n === undefined || !Number.isFinite(n) ? fallback : n.toFixed(digits);
  }

  statusItemHtml(name, hint, state, compact = false) {
    if (compact) {
      return `
        <div class="statusItem">
          <div>${esc(name)}</div>
          <div class="pill ${state ? 'on' : 'off'}">${state ? 'EIN' : 'AUS'}</div>
        </div>
      `;
    }
    return `
      <div class="statusItem">
        <div>
          <div class="statusName">${esc(name)}</div>
          <div class="statusHint">${esc(hint)}</div>
        </div>
        <div class="pill ${state ? 'on' : 'off'}">${state ? 'EIN' : 'AUS'}</div>
      </div>
    `;
  }

  buildTabletHtml(data) {
    const phNum = parseNum(data.ph);
    const phSetNum = parseNum(data.phSet);
    const orpNum = parseNum(data.orp);
    const orpOnNum = parseNum(data.orpOnThreshold);
    const orpOffNum = parseNum(data.orpOffThreshold);

    const phBadge = !Number.isFinite(phNum) || !Number.isFinite(phSetNum)
      ? { cls: 'neutral', txt: '—' }
      : phNum < phSetNum ? { cls: 'low', txt: 'Niedrig' }
      : phNum > phSetNum ? { cls: 'high', txt: 'Hoch' }
      : { cls: 'ok', txt: 'OK' };

    const orpBadge = !Number.isFinite(orpNum) || !Number.isFinite(orpOnNum) || !Number.isFinite(orpOffNum)
      ? { cls: 'neutral', txt: '—' }
      : orpNum < orpOnNum ? { cls: 'low', txt: 'Niedrig' }
      : orpNum > orpOffNum ? { cls: 'high', txt: 'Hoch' }
      : { cls: 'ok', txt: 'OK' };

    const kv = (label, value) => `
      <div class="kv">
        <div class="kv-label">${esc(label)}</div>
        <div class="kv-value">${esc(value)}</div>
      </div>`;

    const status = (name, hint, on) => `
      <div class="status-row">
        <div class="status-left">
          <div class="status-name">${esc(name)}</div>
          <div class="status-hint">${esc(hint)}</div>
        </div>
        <div class="pill ${on ? 'on' : 'off'}">${on ? 'EIN' : 'AUS'}</div>
      </div>`;

    const metric = (label, value, sub = '', badge = null) => `
      <div class="metric">
        <div class="metric-label">${esc(label)}</div>
        <div class="metric-value">${esc(value)}</div>
        ${sub ? `<div class="metric-sub">${esc(sub)}</div>` : ''}
        ${badge ? `<div class="badge ${badge.cls}">${badge.txt}</div>` : ''}
      </div>`;

    const mini = (label, value) => `
      <div class="mini">
        <div class="mini-label">${esc(label)}</div>
        <div class="mini-value">${esc(value)}</div>
      </div>`;

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root{
  --bg:#07111f;--bg2:#0c1b31;--line:rgba(255,255,255,.08);
  --txt:#f8fbff;--muted:#b6c4d8;--accent:#52c7ff;--accent2:#6c7dff;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  font-family:Arial,Helvetica,sans-serif;color:var(--txt);
  background:
    radial-gradient(circle at top left, rgba(82,199,255,.18), transparent 26%),
    radial-gradient(circle at bottom right, rgba(108,125,255,.16), transparent 24%),
    linear-gradient(180deg,var(--bg2),var(--bg));
}
.wrap{width:100%;padding:12px}
.layout{display:flex;gap:14px;align-items:flex-start}
.col-left{flex:0 0 29%}
.col-mid{flex:0 0 33%}
.col-right{flex:1 1 0}
.card{
  background:linear-gradient(180deg,rgba(15,32,57,.94),rgba(10,24,44,.96));
  border:1px solid var(--line);border-radius:24px;padding:16px;overflow:hidden;
  box-shadow:0 18px 40px rgba(0,0,0,.28)
}
.hero{
  background:
    radial-gradient(circle at top right, rgba(82,199,255,.22), transparent 28%),
    linear-gradient(180deg,rgba(21,43,74,.96),rgba(11,26,48,.98));
  min-height:430px;
}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.title{font-size:18px;font-weight:900;letter-spacing:.2px}
.meta{text-align:right;font-size:11px;color:var(--muted);line-height:1.2;max-width:96px}
.mode{display:inline-flex;align-items:center;justify-content:center;padding:4px 9px;border-radius:999px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:10px;font-weight:900;margin-bottom:6px}
.temp-wrap{margin:18px 0 14px;display:flex;align-items:flex-end;gap:8px}
.temp{font-size:82px;font-weight:900;line-height:.9}
.unit{font-size:22px;color:#c7d6ea;padding-bottom:9px}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:110px}
.metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.06);border-radius:18px;padding:12px;min-height:96px}
.metric-label{font-size:12px;color:#c8d4e6;font-weight:800;margin-bottom:6px}
.metric-value{font-size:20px;font-weight:900;line-height:1.05}
.metric-sub{font-size:11px;color:#aebed5;margin-top:7px}
.badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;margin-top:8px;font-size:11px;font-weight:900}
.badge.ok{background:rgba(64,196,99,.18);color:#8ff0ab}
.badge.low{background:rgba(255,176,32,.18);color:#ffd480}
.badge.high{background:rgba(255,107,87,.18);color:#ffb2a6}
.badge.neutral{background:rgba(148,163,184,.18);color:#d8e1ec}
.section{font-size:16px;font-weight:900;margin-bottom:10px}
.stack{display:grid;gap:8px}
.kv{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.05);border-radius:16px;padding:11px}
.kv-label{font-size:12px;color:#b7c6db;font-weight:800;max-width:42%}
.kv-value{font-size:15px;font-weight:900;line-height:1.2;text-align:right;word-break:break-word;max-width:58%}
.status-card{margin-bottom:14px}
.status-list{display:grid;gap:10px}
.status-row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.05);border-radius:16px;padding:12px}
.status-left{min-width:0;max-width:calc(100% - 86px)}
.status-name{font-size:16px;font-weight:900;line-height:1.1}
.status-hint{font-size:11px;color:#aebed5;margin-top:4px}
.pill{min-width:76px;text-align:center;padding:9px 11px;border-radius:999px;font-size:12px;font-weight:900;color:#fff;flex:0 0 auto}
.pill.on{background:linear-gradient(180deg,#56d56e,#36b357)}
.pill.off{background:linear-gradient(180deg,#f36e62,#df4a3d)}
.mini-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.mini{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.05);border-radius:16px;padding:12px}
.mini-label{font-size:12px;color:#b7c6db;font-weight:800;margin-bottom:6px}
.mini-value{font-size:18px;font-weight:900;line-height:1.1}
@media (max-width:1100px){
  .layout{display:block}
  .col-left,.col-mid,.col-right{width:auto}
  .col-mid,.col-right{margin-top:14px}
}
</style></head><body><div class="wrap"><div class="layout">
  <div class="col-left">
    <div class="card hero">
      <div class="head">
        <div class="title">Pool Manager</div>
        <div class="meta">
          <div class="mode">${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}</div><br>
          Aktualisiert<br>${esc(data.updated)}
        </div>
      </div>
      <div class="temp-wrap">
        <div class="temp">${esc(data.poolTemp)}</div>
        <div class="unit">°C</div>
      </div>
      <div class="metrics">
        ${metric('pH', data.ph, `Soll ${data.phSet}`, phBadge)}
        ${metric('ORP', data.orp, `Soll ${data.orpSet}`, orpBadge)}
        ${metric('Außen', `${data.outsideTemp}°C`, 'Außentemperatur')}
        ${metric('Solltemp', `${data.targetTemp}°C`, 'Zieltemperatur')}
      </div>
    </div>
  </div>

  <div class="col-mid">
    <div class="card">
      <div class="section">Energie & Steuerung</div>
      <div class="stack">
        ${kv('PV-Leistung', `${data.pv} W`)}
        ${kv('Netzeinspeisung', `${data.feedIn} W`)}
        ${kv('Netzbezug', `${data.gridSupply} W`)}
        ${kv('Batterie SoC', `${data.battery} %`)}
        ${kv('WP Freigabe', data.heatReason)}
        ${kv('Chlor Freigabe', data.chlorDecision)}
        ${kv('Pumpe Zeitplan', data.pumpDecision)}
        ${kv('pH Prüfung', data.phDecision)}
        ${kv('pH Zeiten', data.phTimes)}
        ${kv('Standby nächster Lauf', data.standbyNext)}
        ${kv('Letzte Dosierung', `${data.phLastDoseDurationSec} s`)}
      </div>
    </div>
  </div>

  <div class="col-right">
    <div class="card status-card">
      <div class="section">Aktoren & Status</div>
      <div class="status-list">
        ${status('Umwälzpumpe', 'IST-Zustand', data.pumpOn)}
        ${status('Chlorinator', 'ORP-Regelung', data.chlorOn)}
        ${status('pH-Dosierpumpe', 'Prüfzeiten / Dosierung', data.phPumpOn)}
        ${status('Wärmepumpe', 'PV-Freigabe', data.heatpumpOn)}
      </div>
    </div>
    <div class="card">
      <div class="section">Zusatzwerte</div>
      <div class="mini-list">
        ${mini('Pumpe Zeitplan', data.pumpScheduleActive ? 'AKTIV' : 'INAKTIV')}
        ${mini('PV Schwelle', `${data.threshold} W`)}
        ${mini('ORP Grenzen', `${data.orpOnThreshold} / ${data.orpOffThreshold}`)}
        ${mini('pH Tag', `${data.phDailyCount}`)}
        ${mini('Pumpe ml/min', `${data.phFlowMlMin}`)}
        ${mini('ml je 0,1 / 10m³', `${data.phMlPer01Per10}`)}
        ${mini('Poolvolumen', `${data.volume} m³`)}
      </div>
    </div>
  </div>
</div></div></body></html>`;
  }

  buildPhoneHtml(data) {
    const status = [
      this.statusItemHtml('Umwälzpumpe', '', data.pumpOn, true),
      this.statusItemHtml('Chlorinator', '', data.chlorOn, true),
      this.statusItemHtml('pH-Dosierpumpe', '', data.phPumpOn, true),
      this.statusItemHtml('Wärmepumpe', '', data.heatpumpOn, true),
    ].join('');

    const row = (label, value) => `<div class="row"><div>${esc(label)}</div><div><b>${esc(value)}</b></div></div>`;

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<style>
:root{--bg:#0f172a;--card:#111827;--line:#334155;--text:#f8fafc;--muted:#94a3b8;--ok:#22c55e;--off:#ef4444}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0b1220,#111827);font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:var(--text)}
.wrap{padding:14px 14px 14px 0;max-width:430px;margin:0}
.card{background:rgba(17,24,39,.96);border:1px solid var(--line);border-radius:20px;padding:14px;margin-bottom:12px}
.h1{font-size:24px;font-weight:700}.sub{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.3}
.temp{font-size:56px;font-weight:700;line-height:1;margin:14px 0}
.grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.box{background:rgba(15,23,42,.5);border:1px solid var(--line);border-radius:14px;padding:10px}
.k{font-size:12px;color:var(--muted);margin-bottom:4px}
.v{font-size:26px;font-weight:700;line-height:1.1}
.row{display:grid;grid-template-columns:minmax(110px,140px) minmax(0,1fr);gap:10px;align-items:start;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.12)}
.row:last-child{border-bottom:none}
.row b{line-height:1.25;overflow-wrap:anywhere;word-break:break-word}
.statusItem{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.12)}
.statusItem:last-child{border-bottom:none}
.pill{min-width:74px;text-align:center;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:700;color:#fff}.on{background:var(--ok)}.off{background:var(--off)}
</style></head><body><div class="wrap">
<div class="card">
  <div class="h1">Pool Manager</div>
  <div class="sub">Modus: ${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}<br>Aktualisiert: ${esc(data.updated)}</div>
  <div class="temp">${esc(data.poolTemp)}°C</div>
  <div class="grid2">
    <div class="box"><div class="k">pH</div><div class="v">${esc(data.ph)}</div></div>
    <div class="box"><div class="k">ORP</div><div class="v">${esc(data.orp)}</div></div>
    <div class="box"><div class="k">Außen</div><div class="v">${esc(data.outsideTemp)}°C</div></div>
    <div class="box"><div class="k">Soll</div><div class="v">${esc(data.targetTemp)}°C</div></div>
  </div>
</div>
<div class="card">
  <div class="h1" style="font-size:20px">Energie</div>
  ${row('PV-Leistung', `${data.pv} W`)}
  ${row('Netzeinspeisung', `${data.feedIn} W`)}
  ${row('Netzbezug', `${data.gridSupply} W`)}
  ${row('Batterie SoC', `${data.battery} %`)}
  ${row('PV-Schwelle', `${data.threshold} W`)}
</div>
<div class="card">
  <div class="h1" style="font-size:20px">Steuerung</div>
  ${row('Pumpe', data.pumpDecision)}
  ${row('Chlor', data.chlorDecision)}
  ${row('pH', data.phDecision)}
  ${row('Wärmepumpe', data.heatReason)}
  ${row('Standby nächster Lauf', data.standbyNext)}
</div>
<div class="card">
  <div class="h1" style="font-size:20px">Status</div>
  ${row('pH Prüfzeiten', data.phTimes)}
  ${row('Letzte Dosierung', `${data.phLastDoseDurationSec} s`)}
  ${row('pH Tag', data.phDailyCount)}
  ${row('ORP Grenzen', `${data.orpOnThreshold} / ${data.orpOffThreshold}`)}
  ${row('Poolvolumen', `${data.volume} m³`)}
</div>
<div class="card">
  <div class="h1" style="font-size:20px">Aktoren</div>
  ${status}
</div>
</div></body></html>`;
  }

  async updateComputedStates() {
    const volume = this.calcVolume();
    await this.ensureState('info.poolVolume', 'number', 'value.volume', 0, false);
    await this.setStateAsync('info.poolVolume', volume, true);
  }


  buildTabletWidget(data) {
    const badgeClass = (value, low, high) => {
      const n = parseNum(value);
      if (!Number.isFinite(n)) return 'neutral';
      if (n < low) return 'warn';
      if (n > high) return 'bad';
      return 'good';
    };

    const phClass = badgeClass(data.ph, 7.0, 7.4);
    const orpClass = badgeClass(data.orp, Number(data.orpOnThreshold || 725), Number(data.orpOffThreshold || 750));

    const item = (name, hint, on) => `
      <div class="ps-status">
        <div class="ps-status-left">
          <div class="ps-status-name">${esc(name)}</div>
          <div class="ps-status-hint">${esc(hint)}</div>
        </div>
        <div class="ps-pill ${on ? 'on' : 'off'}">${on ? 'EIN' : 'AUS'}</div>
      </div>`;

    const decisionValue = v => `<div class="ps-v ps-wrap">${esc(v)}</div>`;

    return `
<!-- widget-render:${esc(data.updated)} -->
<style>
.ps-root,*{box-sizing:border-box}
.ps-root{
  width:100%;height:100%;padding:10px;
  color:#0f172a;font-family:Arial,Helvetica,sans-serif;
  background:linear-gradient(180deg,#0b1220 0%,#0f172a 100%);
}
.ps-grid{
  display:grid;
  grid-template-columns:minmax(320px,1.15fr) minmax(250px,.9fr) minmax(240px,.8fr);
  gap:10px;
  height:100%;
}
.ps-card{
  display:flex;flex-direction:column;min-width:0;overflow:hidden;
  background:linear-gradient(180deg,#f8fbff 0%,#eef4fb 100%);
  border:1px solid rgba(15,23,42,.08);border-radius:22px;padding:14px;
  box-shadow:0 14px 28px rgba(0,0,0,.18);
}
.ps-hero{background:linear-gradient(180deg,#ffffff 0%,#eef5ff 100%)}
.ps-header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.ps-title{font-size:18px;font-weight:800;color:#0f172a}
.ps-sub{font-size:11px;color:#475569;text-align:right;flex:0 0 auto}
.ps-tempRow{display:flex;align-items:flex-end;gap:8px;margin:10px 0 12px}
.ps-temp{font-size:70px;font-weight:900;line-height:.9;color:#0f172a}
.ps-unit{font-size:20px;color:#475569;padding-bottom:8px}
.ps-metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:auto}
.ps-metric{
  background:#ffffff;border:1px solid rgba(15,23,42,.08);
  border-radius:16px;padding:10px;min-height:76px;
}
.ps-k{font-size:12px;color:#475569;margin-bottom:6px;font-weight:700}
.ps-v{font-size:22px;font-weight:800;line-height:1.15;color:#0f172a}
.ps-v.ps-wrap{
  font-size:14px;font-weight:700;line-height:1.25;
  word-break:break-word;overflow-wrap:anywhere;white-space:normal;
}
.ps-s{font-size:11px;color:#64748b;margin-top:6px}
.ps-chip{display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:800;margin-top:6px}
.ps-chip.good{background:#dcfce7;color:#166534}
.ps-chip.warn{background:#fef3c7;color:#92400e}
.ps-chip.bad{background:#fee2e2;color:#991b1b}
.ps-chip.neutral{background:#e2e8f0;color:#334155}
.ps-list{display:grid;gap:8px}
.ps-row{
  display:grid;grid-template-columns:minmax(90px,120px) minmax(0,1fr);gap:8px;align-items:start;
  background:#ffffff;border:1px solid rgba(15,23,42,.08);border-radius:16px;padding:10px;
}
.ps-statuswrap{display:grid;gap:8px}
.ps-status{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;
  background:#ffffff;border:1px solid rgba(15,23,42,.08);border-radius:16px;padding:12px;
}
.ps-status-left{min-width:0}
.ps-status-name{font-size:16px;font-weight:800;color:#0f172a;line-height:1.15}
.ps-status-hint{
  font-size:11px;color:#64748b;margin-top:4px;
  white-space:normal;overflow-wrap:anywhere;
}
.ps-pill{
  min-width:72px;text-align:center;padding:9px 12px;border-radius:999px;
  font-size:13px;font-weight:800;color:#fff
}
.ps-pill.on{background:#43c05b}
.ps-pill.off{background:#e64a45}
@media (max-width: 1050px){
  .ps-grid{grid-template-columns:1fr}
}
</style>
<div class="ps-root">
  <div class="ps-grid">
    <div class="ps-card ps-hero">
      <div class="ps-header">
        <div>
          <div class="ps-title">Pool Manager</div>
        </div>
        <div class="ps-sub">Modus<br>${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}<br>Aktualisiert<br>${esc(data.updated)}</div>
      </div>
      <div class="ps-tempRow">
        <div class="ps-temp">${esc(data.poolTemp)}</div>
        <div class="ps-unit">°C</div>
      </div>
      <div class="ps-metrics">
        <div class="ps-metric">
          <div class="ps-k">pH</div>
          <div class="ps-v">${esc(data.ph)}</div>
          <div class="ps-s">Soll ${esc(data.phSet)}</div>
          <div class="ps-chip ${phClass}">${phClass === 'good' ? 'OK' : phClass === 'warn' ? 'Niedrig' : 'Hoch'}</div>
        </div>
        <div class="ps-metric">
          <div class="ps-k">ORP</div>
          <div class="ps-v">${esc(data.orp)}</div>
          <div class="ps-s">Soll ${esc(data.orpSet)}</div>
          <div class="ps-chip ${orpClass}">${orpClass === 'good' ? 'OK' : orpClass === 'warn' ? 'Niedrig' : 'Hoch'}</div>
        </div>
        <div class="ps-metric">
          <div class="ps-k">Außen</div>
          <div class="ps-v">${esc(data.outsideTemp)}°C</div>
          <div class="ps-s">Außentemperatur</div>
        </div>
        <div class="ps-metric">
          <div class="ps-k">Solltemp</div>
          <div class="ps-v">${esc(data.targetTemp)}°C</div>
          <div class="ps-s">Zieltemperatur</div>
        </div>
      </div>
    </div>
    <div class="ps-card">
      <div class="ps-title">Energie & Steuerung</div>
      <div class="ps-list">
        <div class="ps-row"><div class="ps-k">PV-Leistung</div><div class="ps-v">${esc(data.pv)} W</div></div>
        <div class="ps-row"><div class="ps-k">Netzeinspeisung</div><div class="ps-v">${esc(data.feedIn)} W</div></div>
        <div class="ps-row"><div class="ps-k">Netzbezug</div><div class="ps-v">${esc(data.gridSupply)} W</div></div>
        <div class="ps-row"><div class="ps-k">Batterie SoC</div><div class="ps-v">${esc(data.battery)} %</div></div>
        <div class="ps-row"><div class="ps-k">WP Freigabe</div>${decisionValue(data.heatDecision)}</div>
        <div class="ps-row"><div class="ps-k">Chlor Freigabe</div>${decisionValue(data.chlorDecision)}</div>
        <div class="ps-row"><div class="ps-k">Pumpe Zeitplan</div>${decisionValue(data.pumpDecision)}</div>
        <div class="ps-row"><div class="ps-k">pH Prüfung</div>${decisionValue(data.phDecision)}</div>
        <div class="ps-row"><div class="ps-k">pH Zeiten</div>${decisionValue(data.phTimes)}</div>
        <div class="ps-row"><div class="ps-k">Standby nächster Lauf</div>${decisionValue(data.standbyNext)}</div>
        <div class="ps-row"><div class="ps-k">Letzte Dosierung</div><div class="ps-v">${esc(data.phLastDoseDurationSec)} s</div></div>
      </div>
    </div>
    <div class="ps-card">
      <div class="ps-title">Aktoren & Status</div>
      <div class="ps-statuswrap">
        ${item('Umwälzpumpe','IST-Zustand',data.pumpOn)}
        ${item('Chlorinator','ORP-Regelung',data.chlorOn)}
        ${item('pH-Dosierpumpe','Prüfzeiten / Dosierung',data.phPumpOn)}
        ${item('Wärmepumpe','PV-Freigabe',data.heatpumpOn)}
      </div>
      <div class="ps-list" style="margin-top:10px">
        <div class="ps-row"><div class="ps-k">Pumpe Zeitplan</div><div class="ps-v">${data.pumpScheduleActive ? 'AKTIV' : 'INAKTIV'}</div></div>
        <div class="ps-row"><div class="ps-k">PV Schwelle</div><div class="ps-v">${esc(data.threshold)} W</div></div>
        <div class="ps-row"><div class="ps-k">ORP Grenzen</div><div class="ps-v">${esc(data.orpOnThreshold)} / ${esc(data.orpOffThreshold)}</div></div>
        <div class="ps-row"><div class="ps-k">pH Tag</div><div class="ps-v">${esc(data.phDailyCount)}</div></div>
        <div class="ps-row"><div class="ps-k">Pumpe ml/min</div><div class="ps-v">${esc(data.phFlowMlMin)}</div></div>
        <div class="ps-row"><div class="ps-k">ml je 0,1 / 10m³</div><div class="ps-v">${esc(data.phMlPer01Per10)}</div></div>
        <div class="ps-row"><div class="ps-k">Poolvolumen</div><div class="ps-v">${esc(data.volume)} m³</div></div>
      </div>
    </div>
  </div>
</div>`;
  }

  buildPhoneWidget(data) {
    const badgeClass = (value, low, high) => {
      const n = parseNum(value);
      if (!Number.isFinite(n)) return 'neutral';
      if (n < low) return 'warn';
      if (n > high) return 'bad';
      return 'good';
    };

    const phClass = badgeClass(data.ph, 7.0, 7.4);
    const orpClass = badgeClass(data.orp, Number(data.orpOnThreshold || 725), Number(data.orpOffThreshold || 750));

    const item = (label, value) => `
      <div class="pp-row">
        <div class="pp-k">${esc(label)}</div>
        <div class="pp-v">${esc(value)}</div>
      </div>`;

    return `
<!-- phone-render:${esc(data.updated)} -->
<style>
.pp-root,*{box-sizing:border-box}
.pp-root{
  width:100%;height:100%;padding:10px;
  font-family:Arial,Helvetica,sans-serif;color:#0f172a;
  background:linear-gradient(180deg,#0b1220 0%,#0f172a 100%);
}
.pp-card{
  background:linear-gradient(180deg,#ffffff 0%,#eef5ff 100%);
  border:1px solid rgba(15,23,42,.08);
  border-radius:20px;
  padding:12px;
  margin-bottom:10px;
  box-shadow:0 10px 24px rgba(0,0,0,.18);
}
.pp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.pp-title{font-size:18px;font-weight:800;color:#0f172a}
.pp-sub{font-size:11px;color:#475569;text-align:right}
.pp-temp{font-size:54px;font-weight:900;line-height:1;margin:10px 0;color:#0f172a}
.pp-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pp-box{
  background:#ffffff;border:1px solid rgba(15,23,42,.08);
  border-radius:14px;padding:10px;min-height:84px;
}
.pp-k{font-size:11px;color:#475569;font-weight:700;margin-bottom:6px}
.pp-v{font-size:22px;font-weight:800;color:#0f172a;line-height:1.1}
.pp-s{font-size:10px;color:#64748b;margin-top:6px}
.pp-chip{display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;border-radius:999px;font-size:10px;font-weight:800;margin-top:6px}
.pp-chip.good{background:#dcfce7;color:#166534}
.pp-chip.warn{background:#fef3c7;color:#92400e}
.pp-chip.bad{background:#fee2e2;color:#991b1b}
.pp-chip.neutral{background:#e2e8f0;color:#334155}
.pp-list{display:grid;gap:8px}
.pp-row{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;
  background:#ffffff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:9px 10px;
}
.pp-row .pp-v{font-size:14px}
.pp-statusgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pp-status{
  background:#ffffff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:10px;
}
.pp-status-name{font-size:12px;font-weight:800;color:#0f172a}
.pp-pill{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:58px;margin-top:8px;padding:7px 9px;border-radius:999px;
  font-size:11px;font-weight:900;color:#fff;
}
.pp-pill.on{background:linear-gradient(180deg,#22c55e,#16a34a)}
.pp-pill.off{background:linear-gradient(180deg,#ef4444,#dc2626)}
</style>

<div class="pp-root">
  <div class="pp-card">
    <div class="pp-head">
      <div class="pp-title">Pool Manager</div>
      <div class="pp-sub">Aktualisiert<br>${esc(data.updated)}</div>
    </div>
    <div class="pp-temp">${esc(data.poolTemp)}°C</div>
    <div class="pp-grid">
      <div class="pp-box">
        <div class="pp-k">pH</div>
        <div class="pp-v">${esc(data.ph)}</div>
        <div class="pp-s">Soll ${esc(data.phSet)}</div>
        <div class="pp-chip ${phClass}">${phClass === 'good' ? 'OK' : phClass === 'warn' ? 'Niedrig' : 'Hoch'}</div>
      </div>
      <div class="pp-box">
        <div class="pp-k">ORP</div>
        <div class="pp-v">${esc(data.orp)}</div>
        <div class="pp-s">Soll ${esc(data.orpSet)}</div>
        <div class="pp-chip ${orpClass}">${orpClass === 'good' ? 'OK' : orpClass === 'warn' ? 'Niedrig' : 'Hoch'}</div>
      </div>
      <div class="pp-box">
        <div class="pp-k">Außen</div>
        <div class="pp-v">${esc(data.outsideTemp)}°C</div>
        <div class="pp-s">Außentemperatur</div>
      </div>
      <div class="pp-box">
        <div class="pp-k">Solltemp</div>
        <div class="pp-v">${esc(data.targetTemp)}°C</div>
        <div class="pp-s">Zieltemperatur</div>
      </div>
    </div>
  </div>

  <div class="pp-card">
    <div class="pp-title" style="font-size:16px">Energie & Steuerung</div>
    <div class="pp-list" style="margin-top:8px">
      ${item('PV-Leistung', `${data.pv} W`)}
      ${item('Netzeinspeisung', `${data.feedIn} W`)}
      ${item('Netzbezug', `${data.gridSupply} W`)}
      ${item('Batterie SoC', `${data.battery} %`)}
      ${item('WP Freigabe', data.heatDecision)}
      ${item('Chlor Freigabe', data.chlorDecision)}
      ${item('Pumpe Zeitplan', data.pumpDecision)}
      ${item('pH Prüfung', data.phDecision)}
      ${item('pH Zeiten', data.phTimes)}
      ${item('Letzte Dosierung', `${data.phLastDoseDurationSec} s`)}
    </div>
  </div>

  <div class="pp-card">
    <div class="pp-title" style="font-size:16px">Aktoren & Status</div>
    <div class="pp-statusgrid" style="margin-top:8px">
      <div class="pp-status"><div class="pp-status-name">Umwälzpumpe</div><div class="pp-pill ${data.pumpOn ? 'on' : 'off'}">${data.pumpOn ? 'EIN' : 'AUS'}</div></div>
      <div class="pp-status"><div class="pp-status-name">Chlorinator</div><div class="pp-pill ${data.chlorOn ? 'on' : 'off'}">${data.chlorOn ? 'EIN' : 'AUS'}</div></div>
      <div class="pp-status"><div class="pp-status-name">pH-Dosierpumpe</div><div class="pp-pill ${data.phPumpOn ? 'on' : 'off'}">${data.phPumpOn ? 'EIN' : 'AUS'}</div></div>
      <div class="pp-status"><div class="pp-status-name">Wärmepumpe</div><div class="pp-pill ${data.heatpumpOn ? 'on' : 'off'}">${data.heatpumpOn ? 'EIN' : 'AUS'}</div></div>
    </div>
    <div class="pp-list" style="margin-top:8px">
      ${item('PV Schwelle', `${data.threshold} W`)}
      ${item('ORP Grenzen', `${data.orpOnThreshold} / ${data.orpOffThreshold}`)}
      ${item('pH Tag', data.phDailyCount)}
      ${item('Pumpe ml/min', data.phFlowMlMin)}
      ${item('ml je 0,1 / 10m³', data.phMlPer01Per10)}
      ${item('Poolvolumen', `${data.volume} m³`)}
    </div>
  </div>
</div>`;
  }

  async renderVis() {
    const ph = this.fmt(await this.getNumber(this.config.phStateId, 2), 2);
    const orp = this.fmt(await this.getNumber(this.config.orpStateId, 0), 0);
    const poolTemp = this.fmt(await this.getNumber(this.config.waterTempStateId, 1), 1);
    const outsideTemp = this.fmt(await this.getNumber(this.config.outsideTempStateId, 1), 1);
    const pv = this.fmt(await this.getNumber(this.config.pvPowerStateId, 0), 0, '0');
    const feedIn = this.fmt(await this.getNumber(this.config.gridFeedInStateId, 0), 0, '0');
    const gridSupply = this.fmt(await this.getNumber(this.config.gridSupplyStateId, 0), 0, '0');
    const battery = this.fmt(await this.getNumber(this.config.batterySocStateId, 0), 0, '0');
    const targetTemp = this.fmt(parseNum(this.config.heatpumpTargetTemp), 1, '24.0');
    const heatReason = await this.getText('poolsteuerung.0.status.heatpump.lastReason', '--');
    const standbyMode = this.config.standbyModeEnabled === true;
    const modeActive = standbyMode ? 'standby' : 'normal';
    const standbyNext = standbyMode ? this.getNextStandbyRun(new Date()) : null;
    const pumpDecision = await this.getText('poolsteuerung.0.status.debug.lastPumpDecision', standbyMode ? 'Standby aktiv' : '--');
    const phDecision = await this.getText('poolsteuerung.0.status.debug.lastPhDecision', '--');
    const phDailyCount = await this.getText('poolsteuerung.0.status.phDose.dailyCount', '0');
    const phLastDoseDurationSec = await this.getText('poolsteuerung.0.status.phDose.lastDoseDurationSec', '0');
    const phFlowMlMin = this.fmt(parseNum(this.config.phPumpFlowMlPerMin), 0, '--');
    const phMlPer01Per10 = this.fmt(parseNum(this.config.phDoseMlPer01Per10m3), 0, '--');
    const volume = this.fmt(this.calcVolume(), 2, '--');

    const circulationEnabled = !standbyMode && this.config.enableCirculationControl !== false;
    const phEnabledMaster = !standbyMode && this.config.enablePhControl !== false;
    const heatEnabledMaster = !standbyMode && this.config.enableHeatpumpControl !== false;
    const chlorEnabledMaster = !standbyMode && this.config.enableChlorControl !== false;

    const pumpOn = await this.getBool(this.config.circulationPumpSocketStateId);
    const pumpScheduleActive = standbyMode ? this.isStandbyPumpActive(new Date()) : (typeof this.isPumpScheduleActive === 'function' ? this.isPumpScheduleActive(new Date()) : false);
    const chlorOnRaw = await this.getBool(this.config.chlorinatorSocketStateId);
    const phPumpOn = await this.getBool(this.config.phPumpSocketStateId);
    const threshold = parseNum(this.config.heatEnableFeedInThresholdW || 1000);

    const orpOnThreshold = parseNum(this.config.orpOnThreshold || 725);
    const orpOffThreshold = parseNum(this.config.orpOffThreshold || 750);

    let chlorDesired = chlorOnRaw;
    let chlorDecision = '';
    if (standbyMode) {
      chlorDesired = false;
      chlorDecision = 'Standby aktiv';
    } else if (!chlorEnabledMaster) {
      chlorDesired = chlorOnRaw;
      chlorDecision = 'Steuerung deaktiviert';
    }
    const orpNum = parseNum(orp);
    const chlorDelaySec = Math.max(0, parseNum(this.config.chlorPumpStartDelaySec || 0));
    const pumpOnForSec = this.getPumpOnForSec();

    if (!chlorEnabledMaster) {
      chlorDecision = 'Steuerung deaktiviert';
    } else if (!pumpOn) {
      chlorDesired = false;
      chlorDecision = 'Pumpe AUS';
    } else if (chlorDelaySec > 0 && pumpOnForSec < chlorDelaySec) {
      chlorDesired = false;
      chlorDecision = `Verzögert nach Pumpenstart (${Math.max(0, chlorDelaySec - pumpOnForSec)}s Rest)`;
    } else if (!Number.isFinite(orpNum)) {
      chlorDesired = false;
      chlorDecision = 'ORP ungültig';
    } else if (orpNum <= orpOnThreshold) {
      chlorDesired = true;
      chlorDecision = `ORP niedrig (${orpNum} <= ${orpOnThreshold})`;
    } else if (orpNum > orpOffThreshold) {
      chlorDesired = false;
      chlorDecision = `ORP hoch (${orpNum} > ${orpOffThreshold})`;
    } else {
      chlorDecision = `Hysterese (${orpOnThreshold}-${orpOffThreshold})`;
    }

    if (this.config.chlorinatorSocketStateId && chlorDesired !== chlorOnRaw) {
      try {
        await this.setSwitchStateCompat(this.config.chlorinatorSocketStateId, chlorDesired);
      } catch (e) {
        this.log.warn('Chlorinator konnte nicht gesetzt werden: ' + e);
      }
    }

    const chlorOn = pumpOn ? chlorDesired : false;
    let heatDecision = '';
    const circulationHeartbeatOkDisplay = await this.getHeartbeatOk('status.checks.circulationPump');
    if (!pumpOn) {
      heatDecision = 'Umwälzpumpe AUS';
    } else if (!circulationHeartbeatOkDisplay) {
      heatDecision = 'Umwälzpumpe nicht erreichbar';
    } else if (parseNum(feedIn) < threshold) {
      heatDecision = `PV zu gering (${feedIn}W < ${threshold}W)`;
    } else if (parseNum(poolTemp) >= parseNum(targetTemp)) {
      heatDecision = 'Solltemperatur erreicht';
    } else {
      heatDecision = `PV OK (${feedIn}W > ${threshold}W)`;
    }

    const heatpumpOn = await this.getBool(this.config.heatpumpPowerStateId);

    const stableData = {
      ph, orp, poolTemp, outsideTemp, pv, feedIn, gridSupply, battery, targetTemp, heatReason, volume, modeActive,
      phSet: this.fmt(parseNum(this.config.phSetpoint), 2, '--'),
      phTimes: standbyMode ? '-' : (this.config.phCheckTimes || '-'),
      standbyNext: standbyNext ? standbyNext.toLocaleString('de-DE') : '-',
      pumpDecision,
      phDecision,
      phDailyCount,
      phLastDoseDurationSec,
      phFlowMlMin,
      phMlPer01Per10,
      orpSet: this.fmt(parseNum(this.config.orpSetpoint), 0, '--'),
      threshold: this.fmt(threshold, 0, '1000'),
      orpOnThreshold: this.fmt(orpOnThreshold, 0, '725'),
      orpOffThreshold: this.fmt(orpOffThreshold, 0, '750'),
      pumpOn,
      pumpScheduleActive,
      chlorOn,
      phPumpOn,
      chlorDecision,
      heatpumpOn,
      heatDecision,
      pvRounded: Math.round(parseNum(pv) / 100) * 100,
      feedInRounded: Math.round(parseNum(feedIn) / 100) * 100,
      gridSupplyRounded: Math.round(parseNum(gridSupply) / 100) * 100,
      batteryRounded: Math.round(parseNum(battery))
    };

    const now = Date.now();
    const signature = JSON.stringify(stableData);

    if (signature === this.lastRenderSignature && now - this.lastRenderAt < 60000) {
      return;
    }

    this.lastRenderSignature = signature;
    this.lastRenderAt = now;

    const data = {
      updated: new Date().toLocaleString('de-DE'),
      ...stableData,
    };

    const tablet = this.buildTabletHtml(data);
    const phone = this.buildPhoneHtml(data);
    const tabletWidget = this.buildTabletWidget(data);
    const phoneWidget = this.buildPhoneWidget(data);

    await this.ensureState('vis.htmlTablet', 'string', 'html', '', false);
    await this.ensureState('vis.htmlPhone', 'string', 'html', '', false);
    await this.ensureState('vis.widgetTablet', 'string', 'html', '', false);
    await this.ensureState('vis.widgetPhone', 'string', 'html', '', false);
    await this.setStateAsync('vis.htmlTablet', tablet, true);
    await this.setStateAsync('vis.htmlPhone', phone, true);
    if (tabletWidget !== this.lastTabletWidget) {
      await this.setStateAsync('vis.widgetTablet', tabletWidget, true);
      this.lastTabletWidget = tabletWidget;
    }
    if (phoneWidget !== this.lastPhoneWidget) {
      await this.setStateAsync('vis.widgetPhone', phoneWidget, true);
      this.lastPhoneWidget = phoneWidget;
    }
    await this.ensureState('status.debug.lastVisUpdate', 'string', 'text', '', false);
    await this.setStateAsync('status.debug.lastVisUpdate', data.updated, true);
    await this.ensureState('status.debug.lastDecision', 'string', 'text', '', false);
    await this.setStateAsync('status.debug.lastDecision', `WP: ${data.heatpumpOn ? 'EIN' : 'AUS'} | ${data.heatDecision} || Chlor: ${data.chlorOn ? 'EIN' : 'AUS'} | ${data.chlorDecision}`, true);

  }

  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(async () => {
      this.renderQueued = false;
      try {
        await this.updateComputedStates();
        if (typeof this.applyControlLogic === 'function') {
          await this.applyControlLogic();
        }
        await this.renderVis();
      } catch (e) {
        this.log.warn('VIS Render Fehler: ' + (e && e.stack ? e.stack : e));
      }
    }, 400);
  }


  getDependencyRules() {
    const rules = Array.isArray(this.config.dependencyRules) ? this.config.dependencyRules : [];
    return rules
      .map((rule, index) => ({
        index,
        enabled: rule && rule.enabled === true,
        name: String((rule && rule.name) || '').trim(),
        compareStateId: String((rule && rule.compareStateId) || '').trim(),
        operator: String((rule && rule.operator) || 'eq').trim(),
        compareValue: rule && rule.compareValue !== undefined && rule.compareValue !== null ? rule.compareValue : '',
        targetStateId: String((rule && rule.targetStateId) || '').trim(),
        thenValue: rule && rule.thenValue !== undefined && rule.thenValue !== null ? rule.thenValue : '',
        elseValue: rule && rule.elseValue !== undefined && rule.elseValue !== null ? rule.elseValue : '',
        logEnabled: rule && rule.logEnabled === true
      }))
      .filter(rule => rule.enabled && rule.compareStateId && rule.targetStateId);
  }

  parseRuleValue(raw) {
    if (raw === undefined || raw === null) return '';
    if (typeof raw === 'boolean' || typeof raw === 'number') return raw;
    const s = String(raw).trim();
    if (s === '') return '';
    const lower = s.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    if (/^-?\d+(?:[\.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
    return s;
  }

  toTruthy(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value ?? '').trim().toLowerCase();
    return ['true', '1', 'on', 'ein', 'yes', 'ja'].includes(s);
  }

  valuesEqual(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (typeof a === 'boolean' || typeof b === 'boolean') return this.toTruthy(a) === this.toTruthy(b);
    return String(a ?? '') === String(b ?? '');
  }

  evaluateRuleCondition(actualRaw, operator, expectedRaw) {
    const expected = this.parseRuleValue(expectedRaw);
    const actual = typeof expected === 'number'
      ? Number(String(actualRaw).replace(',', '.'))
      : typeof expected === 'boolean'
        ? this.toTruthy(actualRaw)
        : actualRaw;

    switch (operator) {
      case 'istrue': return this.toTruthy(actualRaw) === true;
      case 'isfalse': return this.toTruthy(actualRaw) === false;
      case 'eq': return this.valuesEqual(actual, expected);
      case 'neq': return !this.valuesEqual(actual, expected);
      case 'gt': return Number(actual) > Number(expected);
      case 'gte': return Number(actual) >= Number(expected);
      case 'lt': return Number(actual) < Number(expected);
      case 'lte': return Number(actual) <= Number(expected);
      default: return this.valuesEqual(actual, expected);
    }
  }

  async writeRuleTarget(targetStateId, rawValue, ruleName = '') {
    const obj = await this.getForeignObjectAsync(targetStateId);
    const common = obj && obj.common ? obj.common : {};
    let value = this.parseRuleValue(rawValue);

    if (common.type === 'boolean') {
      value = this.toTruthy(value);
    } else if (common.type === 'number') {
      const num = Number(String(value).replace(',', '.'));
      if (!Number.isFinite(num)) throw new Error('Zielwert ist keine gültige Zahl');
      value = num;
    } else if (common.type === 'string') {
      value = String(value);
    }

    const cur = await this.getForeignStateAsync(targetStateId);
    const curVal = cur ? cur.val : undefined;
    if (this.valuesEqual(curVal, value)) return false;
    await this.setForeignStateAsync(targetStateId, value, false);
    return true;
  }

  async applyDependencyRules(changedId = '') {
    if (this.config.adapterEnabled === false) return;
    const rules = this.getDependencyRules();
    if (!rules.length) return;

    for (const rule of rules) {
      if (changedId && rule.compareStateId !== changedId) continue;
      try {
        const state = await this.getForeignStateAsync(rule.compareStateId);
        if (!state) continue;
        const matched = this.evaluateRuleCondition(state.val, rule.operator, rule.compareValue);
        const hasElse = String(rule.elseValue ?? '').trim() !== '';
        const valueToSet = matched ? rule.thenValue : (hasElse ? rule.elseValue : undefined);
        if (valueToSet === undefined) continue;
        const changed = await this.writeRuleTarget(rule.targetStateId, valueToSet, rule.name);
        if (rule.logEnabled && changed) {
          this.log.info(`[REGEL] ${rule.name || `Regel ${rule.index + 1}`} | ${matched ? 'THEN' : 'ELSE'} -> ${rule.targetStateId} = ${valueToSet}`);
        }
      } catch (e) {
        this.log.warn(`[REGEL] ${rule.name || `Regel ${rule.index + 1}`} fehlgeschlagen: ${e.message || e}`);
      }
    }
  }

  async subscribeConfiguredStates() {
    const ruleIds = this.getDependencyRules().map(rule => rule.compareStateId).filter(Boolean);
    this.ruleCompareIds = [...new Set(ruleIds)];

    const ids = [
      this.config.phStateId,
      this.config.orpStateId,
      this.config.waterTempStateId,
      this.config.outsideTempStateId,
      this.config.pvPowerStateId,
      this.config.gridFeedInStateId,
      this.config.gridSupplyStateId,
      this.config.batterySocStateId,
      this.config.phPumpSocketStateId,
      this.config.phDoseEnableStateId,
      this.config.chlorinatorSocketStateId,
      this.config.circulationPumpSocketStateId,
      this.config.heatpumpPowerStateId,
      'poolsteuerung.0.status.heatpump.lastReason',
      ...this.ruleCompareIds
    ].filter(Boolean);

    this.monitoredIds = [...new Set(ids)];
    for (const id of this.monitoredIds) {
      try { this.subscribeForeignStates(id); } catch {}
    }
  }


  parseHHMM(value) {
    const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = Number(m[1]), mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  getStandbyDurationSec() {
    return Math.max(1, parseNum(this.config.standbyPumpDurationSec || 30));
  }

  getStandbyRunWindow(now = new Date()) {
    const mins = this.parseHHMM(this.config.standbyRunTime || '12:00');
    if (mins === null) return null;
    const start = new Date(now);
    start.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    const end = new Date(start.getTime() + this.getStandbyDurationSec() * 1000);
    return { start, end };
  }

  isStandbyPumpActive(now = new Date()) {
    if (this.config.standbyModeEnabled !== true) return false;
    const window = this.getStandbyRunWindow(now);
    if (!window) return false;
    return now >= window.start && now < window.end;
  }

  getNextStandbyRun(now = new Date()) {
    const mins = this.parseHHMM(this.config.standbyRunTime || '12:00');
    if (mins === null) return null;
    const next = new Date(now);
    next.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  isWindowActive(startText, endText, now = new Date()) {
    const start = this.parseHHMM(startText);
    const end = this.parseHHMM(endText);
    if (start === null || end === null) return false;
    if (start === 0 && end === 0) return false;
    if (start === end) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end;
  }

  isPumpScheduleActive(now = new Date()) {
    return this.isWindowActive(this.config.pumpWindow1Start, this.config.pumpWindow1End, now) ||
           this.isWindowActive(this.config.pumpWindow2Start, this.config.pumpWindow2End, now);
  }

  isPhCheckDue(now = new Date()) {
    const list = String(this.config.phCheckTimes || '').split(',').map(v => v.trim()).filter(Boolean);
    const current = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    return list.includes(current);
  }


  getTodayKey(now = new Date()) {
    return now.toISOString().slice(0, 10);
  }

  async getTodayDoseCount(now = new Date()) {
    await this.ensureState('status.phDose.dayKey', 'string', 'text', '', false);
    await this.ensureState('status.phDose.dailyCount', 'number', 'value', 0, false);
    const dayKeyState = await this.getStateAsync('status.phDose.dayKey');
    const countState = await this.getStateAsync('status.phDose.dailyCount');
    const today = this.getTodayKey(now);
    let count = Number(countState && countState.val) || 0;
    if (!dayKeyState || dayKeyState.val !== today) {
      count = 0;
      await this.setStateAsync('status.phDose.dayKey', today, true);
      await this.setStateAsync('status.phDose.dailyCount', 0, true);
    }
    return count;
  }

  async incrementTodayDoseCount(now = new Date()) {
    const count = await this.getTodayDoseCount(now);
    await this.setStateAsync('status.phDose.dayKey', this.getTodayKey(now), true);
    await this.setStateAsync('status.phDose.dailyCount', count + 1, true);
    return count + 1;
  }


  calcPhDoseDurationSec(phValue, phSet, tolerance) {
    const delta = Number(phValue) - (Number(phSet) + Number(tolerance));
    if (!Number.isFinite(delta) || delta <= 0) return 0;

    const volume = this.calcVolume();
    const flowMlPerMin = Math.max(1, parseNum(this.config.phPumpFlowMlPerMin || 60));
    const mlPer01Per10m3 = parseNum(this.config.phDoseMlPer01Per10m3 || 0);
    const baseSec = parseNum(this.config.phDoseSecondsPer01Per10m3 || 30);
    const maxSec = Math.max(1, parseNum(this.config.phDoseMaxDurationSec || 180));

    let sec = 0;

    if (mlPer01Per10m3 > 0) {
      const mlNeeded = (delta / 0.1) * (volume / 10) * mlPer01Per10m3;
      sec = Math.round((mlNeeded / flowMlPerMin) * 60);
    } else {
      sec = Math.round((delta / 0.1) * (volume / 10) * baseSec);
    }

    if (!Number.isFinite(sec) || sec < 0) return 0;
    return Math.min(sec, maxSec);
  }

  async runDosePumpOnce(seconds, context = {}) {
    const pumpId = this.config.phPumpSocketStateId;
    const circulationId = this.config.circulationPumpSocketStateId;
    const sec = Math.max(1, Number(seconds) || 1);
    if (!pumpId || sec <= 0) return false;

    await this.ensureState('status.phDose.stopAtTs', 'number', 'value.time', 0, false);
    await this.ensureState('status.phDose.lastDoseTs', 'number', 'value.time', 0, false);
    await this.ensureState('status.phDose.lastDoseDurationSec', 'number', 'value.interval', 0, false);
    await this.ensureState('status.debug.lastPhStartInfo', 'string', 'text', '', false);

    const circulationOn = circulationId ? await this.getBool(circulationId) : false;
    const circulationHeartbeatOk = await this.getHeartbeatOk('status.checks.circulationPump');
    const phPumpHeartbeatOk = await this.getHeartbeatOk('status.checks.phPump');
    if (!circulationOn) {
      await this.setPhStopAtTs(0, 'Start abgebrochen: Umwälzpumpe AUS');
      if (this.config.debugMode) this.log.info('[PH] Dosierung nicht gestartet: Umwälzpumpe AUS');
      return false;
    }
    if (!circulationHeartbeatOk) {
      await this.setPhStopAtTs(0, 'Start blockiert: Umwälzpumpe nicht erreichbar');
      this.log.warn('[PH] Dosierung blockiert: Umwälzpumpe nicht erreichbar');
      return false;
    }
    if (!phPumpHeartbeatOk) {
      await this.setPhStopAtTs(0, 'Start blockiert: pH-Dosierpumpe nicht erreichbar');
      this.log.warn('[PH] Dosierung blockiert: pH-Dosierpumpe nicht erreichbar');
      return false;
    }

    const stopAtTs = Date.now() + sec * 1000;
    this.phDoseStopAtTsMemory = stopAtTs;

    if (this.config.simulateMode) {
      await this.setPhStopAtTs(stopAtTs, 'Start Simulationsmodus');
      await this.setPhDoseHistory(Date.now(), sec);
      const msg = `[PH] würde dosieren | Prüfzeit ${context.checkTime || '-'} | pH=${context.phValue ?? '-'} | Laufzeit=${sec}s | Stop um ${new Date(stopAtTs).toLocaleTimeString('de-DE')}`;
      await this.setStateAsync('status.debug.lastPhStartInfo', msg, true);
      if (this.config.debugMode) this.log.info(msg);
      return true;
    }

    const onOk = await this.forceSwitchOnCompat(pumpId);
    if (!onOk) {
      this.log.warn('[PH] Dosierpumpe ließ sich nicht sicher einschalten');
      return false;
    }

    await this.setPhStopAtTs(stopAtTs, 'PH-Start erfolgreich');
    await this.setPhDoseHistory(Date.now(), sec);


    const msg = `[PH] Dosierpumpe EIN | Prüfzeit ${context.checkTime || '-'} | pH=${context.phValue ?? '-'} | Laufzeit=${sec}s | Stop um ${new Date(stopAtTs).toLocaleTimeString('de-DE')}`;
    await this.setStateAsync('status.debug.lastPhStartInfo', msg, true);
    if (this.config.debugMode) this.log.info(msg);
    if (this.config.alertOnPhDoseStarted) {
      await this.sendAlert('ph_dose_started', 'info', `Poolsteuerung: pH-Dosierung gestartet | pH ${context.phValue ?? '-'} | Laufzeit ${sec}s`);
    }

    const stopLater = async () => { await this.enforcePhStopIfDue(); };
    setTimeout(stopLater, sec * 1000);
    setTimeout(stopLater, sec * 1000 + 1500);
    setTimeout(stopLater, sec * 1000 + 4000);
    setTimeout(stopLater, sec * 1000 + 8000);

    return true;
  }

  async applyControlLogic() {
    const now = new Date();
    const pumpId = this.config.circulationPumpSocketStateId;
    const standbyMode = this.config.standbyModeEnabled === true;
    const circulationEnabled = !standbyMode && this.config.enableCirculationControl !== false;
    const phEnabledMaster = !standbyMode && this.config.enablePhControl !== false;
    const heatEnabledMaster = !standbyMode && this.config.enableHeatpumpControl !== false;
    const chlorEnabledMaster = !standbyMode && this.config.enableChlorControl !== false;
    const pumpTarget = standbyMode ? this.isStandbyPumpActive(now) : (circulationEnabled ? this.isPumpScheduleActive(now) : false);
    const pumpState = await this.getStateSnapshot(pumpId);
    const pumpCurrent = !!(pumpState && pumpState.val);
    this.updateCirculationPumpRuntime(pumpCurrent, pumpState && (pumpState.lc || pumpState.ts));

    await this.ensureState('status.debug.lastPumpScheduleActive', 'boolean', 'indicator', false, false);
    await this.ensureState('status.debug.lastPumpLoggedDecision', 'string', 'text', '', false);
    const lastScheduleActive = this.lastPumpScheduleActiveMemory === null ? pumpTarget : this.lastPumpScheduleActiveMemory;
    const scheduleEdge = pumpTarget !== lastScheduleActive;
    const nowMs = now.getTime();

    let pumpDecision = standbyMode ? (pumpTarget ? `Standby-Kurzlauf aktiv (${this.getStandbyDurationSec()}s)` : 'Standby aktiv') : (!circulationEnabled ? 'Steuerung deaktiviert' : (pumpTarget ? 'Zeitfenster aktiv' : 'Kein aktives Zeitfenster'));

    if (standbyMode) {
      if (this.config.simulateMode) {
        pumpDecision = pumpTarget ? `würde EIN (Standby ${this.getStandbyDurationSec()}s, Simulationsmodus)` : 'Standby aktiv (Simulationsmodus)';
      } else if (pumpId && pumpCurrent !== pumpTarget) {
        try {
          await this.setSwitchStateCompat(pumpId, pumpTarget);
          this.suppressOwnPumpLogUntil = Date.now() + 5000;
          pumpDecision = pumpTarget ? `EIN via Standby-Kurzlauf (${this.getStandbyDurationSec()}s)` : 'AUS nach Standby-Kurzlauf';
          this.log.info(pumpTarget
            ? `[STANDBY] Umwälzpumpe EIN | Kurzlauf ${this.getStandbyDurationSec()}s`
            : '[STANDBY] Umwälzpumpe AUS | Kurzlauf beendet');
        } catch (e) {
          pumpDecision = `Standby Schaltfehler: ${e.message || e}`;
        }
      }
    } else if (!circulationEnabled) {
      pumpDecision = pumpCurrent ? 'Manuell EIN (Steuerung deaktiviert)' : 'Steuerung deaktiviert';
    } else if (scheduleEdge) {
      if (this.config.simulateMode) {
        pumpDecision = `würde ${pumpTarget ? 'EIN' : 'AUS'} (Zeitfensterwechsel, Simulationsmodus)`;
      } else if (pumpId) {
        try {
          await this.setSwitchStateCompat(pumpId, pumpTarget);
          this.suppressOwnPumpLogUntil = Date.now() + 5000;
          pumpDecision = `${pumpTarget ? 'EIN' : 'AUS'} via Zeitfensterwechsel`;
        } catch (e) {
          pumpDecision = `Schaltfehler: ${e.message || e}`;
        }
      }
    } else if (pumpCurrent && !pumpTarget) {
      pumpDecision = 'Manueller Override aktiv';
    } else if (pumpCurrent && pumpTarget) {
      pumpDecision = 'EIN (Zeitfenster aktiv)';
    } else if (!pumpCurrent && pumpTarget) {
      pumpDecision = 'Manuell AUS trotz Zeitfenster';
    } else {
      pumpDecision = 'AUS (kein Zeitfenster)';
    }

    this.lastPumpScheduleActiveMemory = pumpTarget;
    await this.setStateAsync('status.debug.lastPumpScheduleActive', pumpTarget, true);
    await this.ensureState('status.mode.active', 'string', 'text', 'normal', false);
    await this.setStateAsync('status.mode.active', standbyMode ? 'standby' : 'normal', true);
    await this.ensureState('status.standby.nextRun', 'string', 'text', '', false);
    await this.ensureState('status.standby.lastRun', 'number', 'value.time', 0, false);
    await this.ensureState('status.standby.lastDurationSec', 'number', 'value.interval', 0, false);
    if (standbyMode) {
      const standbyNext = this.getNextStandbyRun(now);
      await this.setStateAsync('status.standby.nextRun', standbyNext ? standbyNext.toLocaleString('de-DE') : 'ungültige Uhrzeit', true);
      if (pumpTarget) {
        await this.setStateAsync('status.standby.lastRun', now.getTime(), true);
        await this.setStateAsync('status.standby.lastDurationSec', this.getStandbyDurationSec(), true);
      }
    }

    const orpValue = await this.getNumber(this.config.orpStateId, 0);
    const chlorId = this.config.chlorinatorSocketStateId;
    const chlorCurrent = await this.getBool(chlorId);
    const orpOnThreshold = parseNum(this.config.orpOnThreshold || 725);
    const orpOffThreshold = parseNum(this.config.orpOffThreshold || 750);
    const chlorDelaySec = Math.max(0, parseNum(this.config.chlorPumpStartDelaySec || 0));
    const pumpOnForSec = this.getPumpOnForSec(nowMs);
    let chlorDecision = 'keine Prüfung';
    let chlorTarget = chlorCurrent;
    const circulationHeartbeatOk = await this.getHeartbeatOk('status.checks.circulationPump');
    const chlorHeartbeatOk = await this.getHeartbeatOk('status.checks.chlorinator');

    if (!chlorEnabledMaster) {
      chlorDecision = chlorCurrent ? 'Steuerung deaktiviert (bleibt EIN)' : 'Steuerung deaktiviert';
    } else if (!pumpCurrent) {
      chlorTarget = false;
      chlorDecision = 'Pumpe AUS';
    } else if (!circulationHeartbeatOk) {
      chlorTarget = false;
      chlorDecision = 'Blockiert: Umwälzpumpe nicht erreichbar';
    } else if (!chlorHeartbeatOk) {
      chlorTarget = false;
      chlorDecision = 'Blockiert: Chlorinator nicht erreichbar';
    } else if (chlorDelaySec > 0 && pumpOnForSec < chlorDelaySec) {
      chlorTarget = false;
      chlorDecision = `Verzögert nach Pumpenstart (${Math.max(0, chlorDelaySec - pumpOnForSec)}s Rest)`;
    } else if (orpValue === null || !Number.isFinite(orpValue)) {
      chlorTarget = false;
      chlorDecision = 'ORP ungültig';
    } else if (orpValue <= orpOnThreshold) {
      chlorTarget = true;
      chlorDecision = `ORP niedrig (${orpValue} <= ${orpOnThreshold})`;
    } else if (orpValue > orpOffThreshold) {
      chlorTarget = false;
      chlorDecision = `ORP hoch (${orpValue} > ${orpOffThreshold})`;
    } else {
      chlorDecision = `Hysterese (${orpOnThreshold}-${orpOffThreshold})`;
    }

    if (!this.config.simulateMode && chlorId && chlorTarget !== chlorCurrent) {
      try {
        await this.setSwitchStateCompat(chlorId, chlorTarget);
      } catch (e) {
        chlorDecision = `Chlor Schaltfehler: ${e.message || e}`;
        this.log.warn('Chlorinator konnte nicht gesetzt werden: ' + (e.message || e));
      }
    }

    await this.ensureState('status.debug.lastChlorDecision', 'string', 'text', '', false);
    await this.setStateAsync('status.debug.lastChlorDecision', chlorDecision, true);

    const heatpumpId = this.config.heatpumpPowerStateId;
    const currentHeat = await this.getBool(heatpumpId);
    const feedIn = await this.getNumber(this.config.gridFeedInStateId, 0);
    const poolTemp = await this.getNumber(this.config.waterTempStateId, 1);
    const targetTemp = parseNum(this.config.heatpumpTargetTemp || 24);
    const heatThreshold = parseNum(this.config.heatEnableFeedInThresholdW || 1000);
    let heatReason = 'keine Prüfung';
    let shouldHeat = currentHeat;

    if (standbyMode) {
      shouldHeat = false;
      heatReason = 'Standby aktiv';
    } else if (!heatEnabledMaster) {
      shouldHeat = false;
      heatReason = currentHeat ? 'Steuerung deaktiviert (bleibt EIN)' : 'Steuerung deaktiviert';
    } else if (!pumpCurrent) {
      shouldHeat = false;
      heatReason = 'Umwälzpumpe AUS';
    } else if (!circulationHeartbeatOk) {
      shouldHeat = false;
      heatReason = 'Umwälzpumpe nicht erreichbar';
    } else if (feedIn === null || !Number.isFinite(feedIn)) {
      shouldHeat = false;
      heatReason = 'Netzeinspeisung ungültig';
    } else if (poolTemp !== null && Number.isFinite(poolTemp) && Number.isFinite(targetTemp) && poolTemp >= targetTemp) {
      shouldHeat = false;
      heatReason = `Solltemp erreicht (${poolTemp}°C >= ${targetTemp}°C)`;
    } else if (feedIn < heatThreshold) {
      shouldHeat = false;
      heatReason = `PV zu gering (${feedIn}W < ${heatThreshold}W)`;
    } else {
      shouldHeat = true;
      heatReason = `PV OK (${feedIn}W >= ${heatThreshold}W)`;
    }

    if (!this.config.simulateMode && heatpumpId && shouldHeat !== currentHeat) {
      try {
        await this.setSwitchStateCompat(heatpumpId, shouldHeat);
      } catch (e) {
        heatReason = `WP Schaltfehler: ${e.message || e}`;
        this.log.warn('Wärmepumpe konnte nicht gesetzt werden: ' + (e.message || e));
      }
    }

    await this.ensureState('status.heatpump.lastReason', 'string', 'text', '', false);
    await this.setStateAsync('status.heatpump.lastReason', heatReason, true);

    if (standbyMode) {
      if (!this.config.simulateMode) {
        if (chlorId && chlorCurrent) {
          try { await this.forceSwitchOffCompat(chlorId); } catch {}
        }
        if (heatpumpId && currentHeat) {
          try { await this.forceSwitchOffCompat(heatpumpId); } catch {}
        }
      }
    }

    const phValue = await this.getNumber(this.config.phStateId, 2);
    const phSet = parseNum(this.config.phSetpoint || 7.2);
    const phTolerance = parseNum(this.config.phDoseTolerance || 0.05);
    const phEnabledState = this.config.phDoseEnableStateId ? await this.getBool(this.config.phDoseEnableStateId) : true;
    const phEnabled = phEnabledMaster && phEnabledState;
    const phPumpId = this.config.phPumpSocketStateId;
    const phPumpCurrent = await this.getBool(phPumpId);
    await this.ensureState('status.phDose.stopAtTs', 'number', 'value.time', 0, false);
    await this.ensureState('status.debug.lastPhStartInfo', 'string', 'text', '', false);
    const stopAtTs = await this.getEffectivePhStopAtTs(phPumpCurrent);
    const phDoseActive = !!stopAtTs && Date.now() < stopAtTs;

    if (!this.config.simulateMode && standbyMode && (phPumpCurrent || phDoseActive)) {
      try {
        await this.forceSwitchOffCompat(phPumpId);
        await this.setPhStopAtTs(0, 'PH-AUS bestätigt wegen Standby aktiv');
        this.phDoseStopAtTsMemory = 0;
        this.lastWrittenPhStopAtTs = 0;
      } catch {}
    } else if (!this.config.simulateMode && (phPumpCurrent || phDoseActive) && (!pumpCurrent || (stopAtTs && Date.now() >= stopAtTs))) {
      await this.enforcePhStopIfDue();
    }

    const fallbackDoseDurationSec = Math.max(1, parseNum(this.config.phDoseDurationSec || 30));
    const doseLockMinutes = Math.max(0, parseNum(this.config.phDoseLockMinutes || 60));
    const doseMaxPerDay = Math.max(1, parseNum(this.config.phDoseMaxPerDay || 4));
    await this.ensureState('status.phDose.lastDoseTs', 'number', 'value.time', 0, false);
    await this.ensureState('status.phDose.lastDoseDurationSec', 'number', 'value.interval', 0, false);
    await this.ensureState('status.phDose.currentPhValue', 'string', 'text', '--', false);
    await this.ensureState('status.phDose.calculatedDoseSec', 'number', 'value.interval', 0, false);
    const lastDoseState = await this.getStateAsync('status.phDose.lastDoseTs');
    const lastDoseTs = Number(lastDoseState && lastDoseState.val) || 0;
    const lockRemainingMs = Math.max(0, (lastDoseTs + doseLockMinutes * 60000) - nowMs);
    const dailyCount = await this.getTodayDoseCount(now);
    const calcDoseSec = this.calcPhDoseDurationSec(phValue, phSet, phTolerance) || fallbackDoseDurationSec;
    await this.setStateIfChanged('status.phDose.currentPhValue', phValue === null || !Number.isFinite(phValue) ? '--' : String(phValue), true);
    await this.setStateIfChanged('status.phDose.calculatedDoseSec', Number(calcDoseSec) || 0, true);
    const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    let phDecision = 'keine Prüfung';
    if (standbyMode) {
      phDecision = 'Standby aktiv';
    } else if (!phEnabled) {
      phDecision = 'pH Freigabe AUS';
    } else if (!pumpCurrent) {
      phDecision = (phPumpCurrent || phDoseActive) ? 'PH-Dosierung gestoppt (Umwälzpumpe AUS)' : 'Pumpe AUS';
    } else if (!(await this.getHeartbeatOk('status.checks.circulationPump'))) {
      phDecision = 'Blockiert: Umwälzpumpe nicht erreichbar';
    } else if (!(await this.getHeartbeatOk('status.checks.phPump'))) {
      phDecision = 'Blockiert: pH-Dosierpumpe nicht erreichbar';
    } else if (!this.isPhCheckDue(now)) {
      phDecision = `warte auf Prüfzeit (${this.config.phCheckTimes || '-'})`;
    } else if (phValue === null || !Number.isFinite(phValue)) {
      phDecision = 'pH ungültig';
      if (this.config.alertOnSensorError) {
        await this.sendAlert('ph_sensor_invalid', 'warn', 'Poolsteuerung: pH-Sensorwert ist ungültig oder fehlt.');
      }
    } else if (dailyCount >= doseMaxPerDay) {
      phDecision = `Tageslimit erreicht (${dailyCount}/${doseMaxPerDay})`;
      if (this.config.alertOnPhDailyLimit) {
        await this.sendAlert('ph_daily_limit', 'warn', `Poolsteuerung: Tageslimit pH-Dosierung erreicht (${dailyCount}/${doseMaxPerDay}).`);
      }
    } else if (lockRemainingMs > 0) {
      phDecision = `Sperrzeit aktiv (${Math.ceil(lockRemainingMs / 60000)} min)`;
    } else if (phValue <= (phSet + phTolerance)) {
      phDecision = `pH OK (${phValue} <= ${this.fmt(phSet + phTolerance, 2, '--')})`;
    } else if (phPumpCurrent) {
      if (!stopAtTs && this.config.debugMode) {
        // stopAtTs may be held in memory fallback; do not spam logs here.
      }
      phDecision = stopAtTs ? `Dosierpumpe läuft bis ${new Date(stopAtTs).toLocaleTimeString('de-DE')}` : 'Dosierpumpe läuft bereits';
    } else {
      const ok = await this.runDosePumpOnce(calcDoseSec, { checkTime: currentHHMM, phValue });
      if (ok) {
        const newCount = await this.incrementTodayDoseCount(now);
        phDecision = `${this.config.simulateMode ? 'würde dosieren' : 'dosiert'} ${calcDoseSec}s | pH ${phValue} > ${phSet}+${phTolerance} | Tag ${newCount}/${doseMaxPerDay}`;
      } else {
        phDecision = 'Dosierung fehlgeschlagen';
      }
    }

    await this.ensureState('status.debug.lastPumpDecision', 'string', 'text', '', false);
    await this.ensureState('status.debug.lastPhDecision', 'string', 'text', '', false);
    await this.setStateAsync('status.debug.lastPumpDecision', pumpDecision, true);
    const lastPumpLoggedDecisionState = await this.getStateAsync('status.debug.lastPumpLoggedDecision');
    const lastPumpLoggedDecision = lastPumpLoggedDecisionState && lastPumpLoggedDecisionState.val ? String(lastPumpLoggedDecisionState.val) : '';
    const ownWriteSuppressed = Date.now() < (this.suppressOwnPumpLogUntil || 0);
    const shouldLogPump = !ownWriteSuppressed && (scheduleEdge || pumpDecision !== lastPumpLoggedDecision || pumpDecision.startsWith('Schaltfehler'));
    if (shouldLogPump) {
      this.debug(`Pumpenentscheidung: ${pumpDecision} | zeitfenster=${pumpTarget ? 'aktiv' : 'inaktiv'} | ist=${pumpCurrent ? 'ein' : 'aus'} | edge=${scheduleEdge ? 'ja' : 'nein'}`);
      await this.setStateAsync('status.debug.lastPumpLoggedDecision', pumpDecision, true);
    }
    await this.setStateAsync('status.debug.lastPhDecision', phDecision, true);
  }



  async setPhStopAtTs(value, reason = '') {
    const num = Number(value) || 0;
    await this.ensureState('status.phDose.stopAtTs', 'number', 'value.time', 0, false);
    const currentState = await this.getStateAsync('status.phDose.stopAtTs');
    const currentNum = Number(currentState && currentState.val) || 0;

    if (this.lastWrittenPhStopAtTs === null) {
      this.lastWrittenPhStopAtTs = currentNum;
    }

    this.phDoseStopAtTsMemory = num;

    if (num === 0 && currentNum === 0 && this.lastWrittenPhStopAtTs === 0) {
      return;
    }

    if (this.lastWrittenPhStopAtTs === num && currentNum === num) {
      return;
    }

    if (currentNum !== num) {
      await this.setStateAsync('status.phDose.stopAtTs', num, true);
    }

    this.lastWrittenPhStopAtTs = num;

    if (this.config.debugMode) {
      this.log.info(`[PH] stopAtTs ${num ? 'gesetzt' : 'auf 0 gesetzt'}${reason ? ' | ' + reason : ''}${num ? ' | ' + num : ''}`);
    }
  }



  async setPhDoseHistory(ts, durationSec) {
    const tsNum = Number(ts) || 0;
    const durNum = Number(durationSec) || 0;
    this.phLastDoseTsMemory = tsNum;
    this.phLastDoseDurationSecMemory = durNum;
    await this.ensureState('status.phDose.lastDoseTs', 'number', 'value.time', 0, false);
    await this.ensureState('status.phDose.lastDoseDurationSec', 'number', 'value.interval', 0, false);
    await this.setStateIfChanged('status.phDose.lastDoseTs', tsNum, true);
    await this.setStateIfChanged('status.phDose.lastDoseDurationSec', durNum, true);
  }

  async getEffectivePhStopAtTs(phPumpCurrent = false) {
    await this.ensureState('status.phDose.stopAtTs', 'number', 'value.time', 0, false);
    const s = await this.getStateAsync('status.phDose.stopAtTs');
    const stateTs = Number(s && s.val) || 0;
    const memTs = Number(this.phDoseStopAtTsMemory) || 0;

    if (phPumpCurrent && memTs) {
      return memTs;
    }
    return Math.max(stateTs, memTs);
  }



  async resetPhDoseState(reason = '') {
    await this.setPhStopAtTs(0, reason || 'resetPhDoseState');
  }

  async enforcePhStopIfDue() {
    try {
      const phPumpId = this.config.phPumpSocketStateId;
      if (!phPumpId) return;

      const phPumpCurrent = await this.getBool(phPumpId);
      const stopAtTs = await this.getEffectivePhStopAtTs(phPumpCurrent);
      if (!stopAtTs && !this.phDoseStopAtTsMemory) return;

      const pumpCurrent = this.config.circulationPumpSocketStateId
        ? await this.getBool(this.config.circulationPumpSocketStateId)
        : false;
      const circulationHeartbeatOk = await this.getHeartbeatOk('status.checks.circulationPump');
      const phPumpHeartbeatOk = await this.getHeartbeatOk('status.checks.phPump');

      if ((phPumpCurrent || (this.phDoseStopAtTsMemory && Date.now() < this.phDoseStopAtTsMemory + 60000))
          && (!pumpCurrent || !circulationHeartbeatOk || !phPumpHeartbeatOk || Date.now() >= stopAtTs)) {
        const offOk = await this.forceSwitchOffCompat(phPumpId);
        if (offOk) {
          const stopReason = !pumpCurrent
            ? 'Umwälzpumpe AUS'
            : !circulationHeartbeatOk
              ? 'Umwälzpumpe nicht erreichbar'
              : !phPumpHeartbeatOk
                ? 'pH-Dosierpumpe nicht erreichbar'
                : 'Sollzeit erreicht';
          await this.setPhStopAtTs(0, `PH-AUS bestätigt wegen ${stopReason}`);
          this.phDoseStopAtTsMemory = 0;
          this.lastWrittenPhStopAtTs = 0;
          this.log.info(`[PH] Dosierpumpe AUS | Grund ${stopReason}`);
          if ((stopReason === 'Umwälzpumpe AUS' || stopReason === 'Umwälzpumpe nicht erreichbar' || stopReason === 'pH-Dosierpumpe nicht erreichbar') && this.config.alertOnPhDoseAborted) {
            await this.sendAlert('ph_dose_aborted', 'warn', `Poolsteuerung: pH-Dosierung abgebrochen, Grund: ${stopReason}.`);
          } else if (stopReason === 'Sollzeit erreicht' && this.config.alertOnPhDoseStopped) {
            await this.sendAlert('ph_dose_stopped', 'info', 'Poolsteuerung: pH-Dosierung beendet.');
          }
        } else if (this.config.debugMode) {
          this.log.warn(`[PH] Dosierpumpe AUS fehlgeschlagen | Grund ${!pumpCurrent ? 'Umwälzpumpe AUS' : 'Sollzeit erreicht'}`);
        }
      }
    } catch (e) {
      this.log.warn('[PH] Stop-Überwachung fehlgeschlagen: ' + (e.message || e));
    }
  }




  async ensureAlertStates() {
    await this.ensureState('status.alerts.lastMessage', 'string', 'text', '', false);
    await this.ensureState('status.alerts.lastSeverity', 'string', 'text', '', false);
    await this.ensureState('status.alerts.lastKey', 'string', 'text', '', false);
    await this.ensureState('status.alerts.lastSentTs', 'number', 'value.time', 0, false);
  }

  alertsEnabled() {
    return this.config.adapterEnabled !== false && this.config.enableAlerts === true;
  }

  async shouldSendAlert(key) {
    if (!this.alertsEnabled()) return false;
    const lockMin = Math.max(0, Number(this.config.alertRepeatLockMin) || 0);
    const now = Date.now();
    const last = Number(this.alertLockMemory[key]) || 0;
    if (lockMin > 0 && last && now - last < lockMin * 60000) return false;
    this.alertLockMemory[key] = now;
    return true;
  }

  async dispatchWhatsappAlert(message) {
    if (!this.config.alertWhatsappEnabled) return false;
    const instance = String(this.config.alertWhatsappInstance || '').trim();
    const to = String(this.config.alertWhatsappTo || '').trim();
    if (!instance || !to) return false;
    try {
      await this.sendToAsync(instance, 'send', { to, text: message });
      return true;
    } catch (e) {
      this.log.warn('[ALERT] WhatsApp Versand fehlgeschlagen: ' + (e.message || e));
      return false;
    }
  }

  async dispatchTelegramAlert(message) {
    if (!this.config.alertTelegramEnabled) return false;
    const instance = String(this.config.alertTelegramInstance || '').trim();
    const to = String(this.config.alertTelegramTo || '').trim();
    if (!instance || !to) return false;
    try {
      await this.sendToAsync(instance, 'send', { user: to, text: message });
      return true;
    } catch (e) {
      try {
        await this.sendToAsync(instance, 'send', { chatId: to, text: message });
        return true;
      } catch (e2) {
        this.log.warn('[ALERT] Telegram Versand fehlgeschlagen: ' + ((e2 && e2.message) || e2 || (e.message || e)));
        return false;
      }
    }
  }

  async dispatchEmailAlert(message) {
    if (!this.config.alertEmailEnabled) return false;
    const instance = String(this.config.alertEmailInstance || '').trim();
    const to = String(this.config.alertEmailTo || '').trim();
    if (!instance || !to) return false;
    try {
      await this.sendToAsync(instance, 'send', {
        to,
        subject: 'Poolsteuerung Alert',
        text: message
      });
      return true;
    } catch (e) {
      this.log.warn('[ALERT] E-Mail Versand fehlgeschlagen: ' + (e.message || e));
      return false;
    }
  }

  async sendAlert(key, severity, message) {
    await this.ensureAlertStates();
    if (!(await this.shouldSendAlert(key))) return false;

    let sent = false;
    sent = (await this.dispatchWhatsappAlert(message)) || sent;
    sent = (await this.dispatchTelegramAlert(message)) || sent;
    sent = (await this.dispatchEmailAlert(message)) || sent;

    await this.setStateIfChanged('status.alerts.lastMessage', message, true);
    await this.setStateIfChanged('status.alerts.lastSeverity', severity, true);
    await this.setStateIfChanged('status.alerts.lastKey', key, true);
    await this.setStateIfChanged('status.alerts.lastSentTs', Date.now(), true);

    if (sent) {
      this.log.info(`[ALERT] ${message}`);
    } else if (this.alertsEnabled()) {
      this.log.warn(`[ALERT] Kein aktiver Versandkanal oder Versand fehlgeschlagen: ${message}`);
    }
    return sent;
  }

  async onReady() {
    try {
      await this.ensureState('info.connection', 'boolean', 'indicator.connected', false, false);
      await this.ensureState('status.debug.lastCycle', 'string', 'text', '', false);
      await this.ensureState('status.debug.lastStartupError', 'string', 'text', '', false);
      await this.ensureAlertStates();
      await this.setStateAsync('info.connection', true, true);
      await this.subscribeConfiguredStates();
      if (this.config.circulationPumpSocketStateId) {
        const initialPumpState = await this.getStateSnapshot(this.config.circulationPumpSocketStateId);
        this.updateCirculationPumpRuntime(!!(initialPumpState && initialPumpState.val), initialPumpState && (initialPumpState.lc || initialPumpState.ts));
      }
      await this.updateComputedStates();
      await this.runHeartbeatChecks();
      if (typeof this.applyControlLogic === 'function') {
        await this.applyControlLogic();
      }
      await this.applyDependencyRules();
      await this.renderVis();
      await this.logStartupSummary();
      const pollMin = Math.max(1, Number(this.config.pollIntervalMin) || 1);
      if (this.phStopWatcher) clearInterval(this.phStopWatcher);
    this.phStopWatcher = setInterval(async () => {
      await this.enforcePhStopIfDue();
      if (this.config.standbyModeEnabled === true && typeof this.applyControlLogic === 'function') {
        await this.applyControlLogic();
      }
    }, 1000);

    this.timer = setInterval(async () => {
        try {
          await this.setStateAsync('status.debug.lastCycle', new Date().toISOString(), true);
          await this.updateComputedStates();
          await this.runHeartbeatChecks();
          if (typeof this.applyControlLogic === 'function') {
            await this.applyControlLogic();
          }
          await this.applyDependencyRules();
          await this.renderVis();
        } catch (e) {
          this.log.error(`Poll-Fehler: ${e && e.stack ? e.stack : e}`);
          await this.setStateAsync('status.debug.lastStartupError', String(e && e.message ? e.message : e), true);
          if (this.config.alertOnPollError) {
            await this.sendAlert('poll_error', 'error', `Poolsteuerung: Poll-Fehler - ${e && e.message ? e.message : e}`);
          }
        }
      }, pollMin * 60000);
      this.debug(`VIS-HTML aktiv: poolsteuerung.0.vis.htmlTablet / htmlPhone, Poll=${pollMin}min`);
    } catch (e) {
      this.log.error(`Startfehler: ${e && e.stack ? e.stack : e}`);
      try { await this.setStateAsync('status.debug.lastStartupError', String(e && e.message ? e.message : e), true); } catch {}
      try { if (this.config.alertOnPollError) await this.sendAlert('startup_error', 'error', `Poolsteuerung: Startfehler - ${e && e.message ? e.message : e}`); } catch {}
    }
  }

  async onStateChange(id, state) {
    if (!state) return;
    if (this.ruleCompareIds && this.ruleCompareIds.includes(id)) {
      await this.applyDependencyRules(id);
    }
    if (this.monitoredIds.includes(id)) {
      this.debug(`State geändert: ${id}`);
      this.queueRender();
    }
  }

  async onUnload(callback) {
    try {
      if (this.timer) clearInterval(this.timer);
      await this.setStateAsync('info.connection', false, true);
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = options => new Poolsteuerung(options);
} else {
  (() => new Poolsteuerung())();
}

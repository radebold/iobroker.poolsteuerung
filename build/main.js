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
    const status = [
      this.statusItemHtml('Umwälzpumpe', 'Grundlauf / Zeitfenster', data.pumpOn, false),
      this.statusItemHtml('Chlorinator', 'ORP-Regelung', data.chlorOn, false),
      this.statusItemHtml('pH-Dosierpumpe', 'Automatik / manuell', data.phPumpOn, false),
      this.statusItemHtml('Wärmepumpe', 'Solar / Batterie', data.heatpumpOn, false),
    ].join('');

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root{--bg:#0f172a;--card:#111827;--card2:#1f2937;--line:#334155;--text:#f8fafc;--muted:#94a3b8;--ok:#22c55e;--off:#ef4444}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0b1220,#111827);font-family:Arial,Helvetica,sans-serif;color:var(--text)}
.wrap{width:100%;height:100%;padding:20px}.grid{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:16px}
.card{background:linear-gradient(180deg,rgba(17,24,39,.95),rgba(31,41,55,.95));border:1px solid var(--line);border-radius:22px;padding:18px}
.title{font-size:30px;font-weight:700}.sub{font-size:13px;color:var(--muted);margin-top:6px}
.tempMain{font-size:82px;font-weight:700;line-height:1;margin:18px 0 8px}.unit{font-size:28px;color:var(--muted)}
.row{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(148,163,184,.12);padding:12px 0;font-size:20px}.row:last-child{border-bottom:none}
.label{color:var(--muted)}.value{font-weight:700}.miniGrid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:14px}
.mini{background:rgba(15,23,42,.5);border:1px solid var(--line);border-radius:16px;padding:14px}.mini .k{font-size:14px;color:var(--muted);margin-bottom:6px}.mini .v{font-size:34px;font-weight:700}
.status{display:grid;gap:12px}.statusItem{display:flex;justify-content:space-between;align-items:center;background:rgba(15,23,42,.5);border:1px solid var(--line);border-radius:16px;padding:14px}
.statusName{font-size:20px;font-weight:700}.statusHint{font-size:13px;color:var(--muted);margin-top:3px}.pill{min-width:96px;text-align:center;padding:10px 12px;border-radius:999px;font-size:15px;font-weight:700;color:#fff}.on{background:var(--ok)}.off{background:var(--off)}
</style></head><body><div class="wrap"><div class="grid">
<div class="card">
  <div class="title">Pool Manager</div>
  <div class="sub">Aktualisiert: ${esc(data.updated)}</div>
  <div class="tempMain">${esc(data.poolTemp)} <span class="unit">°C</span></div>
  <div class="miniGrid">
    <div class="mini"><div class="k">pH</div><div class="v">${esc(data.ph)}</div></div>
    <div class="mini"><div class="k">ORP</div><div class="v">${esc(data.orp)}</div></div>
    <div class="mini"><div class="k">Außen</div><div class="v">${esc(data.outsideTemp)}°C</div></div>
    <div class="mini"><div class="k">Solltemp</div><div class="v">${esc(data.targetTemp)}°C</div></div>
  </div>
</div>
<div class="card">
  <div class="title" style="font-size:24px">Solar / Energie</div>
  <div class="row"><div class="label">PV-Leistung</div><div class="value">${esc(data.pv)} W</div></div>
  <div class="row"><div class="label">Netzeinspeisung</div><div class="value">${esc(data.feedIn)} W</div></div>
  <div class="row"><div class="label">Netzbezug</div><div class="value">${esc(data.gridSupply)} W</div></div>
  <div class="row"><div class="label">Batterie SoC</div><div class="value">${esc(data.battery)} %</div></div>
  <div class="row"><div class="label">Heizfreigabe</div><div class="value">${esc(data.heatReason)}</div></div>
  <div class="row"><div class="label">Poolvolumen</div><div class="value">${esc(data.volume)} m³</div></div>
</div>
<div class="card">
  <div class="title" style="font-size:24px">Aktoren</div>
  <div class="status">${status}</div>
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

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<style>
:root{--bg:#0f172a;--card:#111827;--line:#334155;--text:#f8fafc;--muted:#94a3b8;--ok:#22c55e;--off:#ef4444}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0b1220,#111827);font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:var(--text)}
.wrap{padding:14px;max-width:390px;margin:0 auto}.card{background:rgba(17,24,39,.96);border:1px solid var(--line);border-radius:20px;padding:14px;margin-bottom:12px}
.h1{font-size:24px;font-weight:700}.sub{font-size:12px;color:var(--muted);margin-top:4px}.temp{font-size:56px;font-weight:700;line-height:1;margin:14px 0}
.grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.box{background:rgba(15,23,42,.5);border:1px solid var(--line);border-radius:14px;padding:10px}
.k{font-size:12px;color:var(--muted);margin-bottom:4px}.v{font-size:26px;font-weight:700}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.12)}.row:last-child{border-bottom:none}
.statusItem{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.12)}.statusItem:last-child{border-bottom:none}
.pill{min-width:74px;text-align:center;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:700;color:#fff}.on{background:var(--ok)}.off{background:var(--off)}
</style></head><body><div class="wrap">
<div class="card">
  <div class="h1">Pool Manager</div>
  <div class="sub">Aktualisiert: ${esc(data.updated)}</div>
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
  <div class="row"><div>PV</div><div><b>${esc(data.pv)} W</b></div></div>
  <div class="row"><div>Einspeisung</div><div><b>${esc(data.feedIn)} W</b></div></div>
  <div class="row"><div>Netzbezug</div><div><b>${esc(data.gridSupply)} W</b></div></div>
  <div class="row"><div>Batterie</div><div><b>${esc(data.battery)} %</b></div></div>
  <div class="row"><div>Freigabe</div><div><b>${esc(data.heatReason)}</b></div></div>
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

    return `
<!-- widget-render:${esc(data.updated)} -->
<style>
.ps-root,*{box-sizing:border-box}
.ps-root{
  width:100%;height:100%;padding:10px;
  color:#0f172a;font-family:Arial,Helvetica,sans-serif;
  background:linear-gradient(180deg,#0b1220 0%,#0f172a 100%);
}
.ps-grid{display:grid;grid-template-columns:1.18fr .92fr .90fr;gap:10px;height:100%}
.ps-card{
  display:flex;flex-direction:column;min-width:0;
  background:linear-gradient(180deg,#f8fbff 0%,#eef4fb 100%);
  border:1px solid rgba(15,23,42,.08);border-radius:22px;padding:14px;
  box-shadow:0 14px 28px rgba(0,0,0,.18);
}
.ps-hero{background:linear-gradient(180deg,#ffffff 0%,#eef5ff 100%)}
.ps-header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.ps-title{font-size:18px;font-weight:800;color:#0f172a}
.ps-sub{font-size:11px;color:#475569;text-align:right}
.ps-tempRow{display:flex;align-items:flex-end;gap:8px;margin:10px 0 12px}
.ps-temp{font-size:70px;font-weight:900;line-height:.9;color:#0f172a}
.ps-unit{font-size:20px;color:#475569;padding-bottom:8px}
.ps-metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:auto}
.ps-metric{
  background:#ffffff;border:1px solid rgba(15,23,42,.08);
  border-radius:16px;padding:10px;min-height:76px;
}
.ps-k{font-size:12px;color:#475569;margin-bottom:6px;font-weight:700}
.ps-v{font-size:22px;font-weight:800;line-height:1.1;color:#0f172a}
.ps-s{font-size:11px;color:#64748b;margin-top:6px}
.ps-chip{display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:800;margin-top:6px}
.ps-chip.good{background:#dcfce7;color:#166534}
.ps-chip.warn{background:#fef3c7;color:#92400e}
.ps-chip.bad{background:#fee2e2;color:#991b1b}
.ps-chip.neutral{background:#e2e8f0;color:#334155}
.ps-list{display:grid;gap:8px;margin-top:10px}
.ps-row{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;
  background:#ffffff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:9px 11px;min-height:42px
}
.ps-row .ps-v{font-size:15px;font-weight:800;white-space:nowrap}
.ps-statuswrap{display:grid;gap:8px;margin-top:10px}
.ps-status{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;
  background:#ffffff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:10px 11px;min-height:58px
}
.ps-status-name{font-size:15px;font-weight:800;color:#0f172a}
.ps-status-hint{font-size:11px;color:#64748b;margin-top:3px}
.ps-pill{
  min-width:72px;text-align:center;padding:8px 10px;border-radius:999px;
  font-size:12px;font-weight:900;color:#fff
}
.ps-pill.on{background:linear-gradient(180deg,#22c55e,#16a34a)}
.ps-pill.off{background:linear-gradient(180deg,#ef4444,#dc2626)}
</style>
<div class="ps-root">
  <div class="ps-grid">
    <div class="ps-card ps-hero">
      <div class="ps-header">
        <div class="ps-title">Pool Manager</div>
        <div class="ps-sub">Aktualisiert<br>${esc(data.updated)}</div>
      </div>
      <div class="ps-tempRow"><div class="ps-temp">${esc(data.poolTemp)}</div><div class="ps-unit">°C</div></div>
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
        <div class="ps-row"><div class="ps-k">WP Freigabe</div><div class="ps-v">${esc(data.heatDecision)}</div></div>
        <div class="ps-row"><div class="ps-k">Chlor Freigabe</div><div class="ps-v">${esc(data.chlorDecision)}</div></div>
        <div class="ps-row"><div class="ps-k">Pumpe Zeitplan</div><div class="ps-v">${esc(data.pumpDecision)}</div></div>
        <div class="ps-row"><div class="ps-k">pH Prüfung</div><div class="ps-v">${esc(data.phDecision)}</div></div>
        <div class="ps-row"><div class="ps-k">pH Zeiten</div><div class="ps-v">${esc(data.phTimes)}</div></div>
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
    const pumpDecision = await this.getText('poolsteuerung.0.status.debug.lastPumpDecision', '--');
    const phDecision = await this.getText('poolsteuerung.0.status.debug.lastPhDecision', '--');
    const phDailyCount = await this.getText('poolsteuerung.0.status.phDose.dailyCount', '0');
    const phLastDoseDurationSec = await this.getText('poolsteuerung.0.status.phDose.lastDoseDurationSec', '0');
    const phFlowMlMin = this.fmt(parseNum(this.config.phPumpFlowMlPerMin), 0, '--');
    const phMlPer01Per10 = this.fmt(parseNum(this.config.phDoseMlPer01Per10m3), 0, '--');
    const volume = this.fmt(this.calcVolume(), 2, '--');

    const circulationEnabled = this.config.enableCirculationControl !== false;
    const phEnabledMaster = this.config.enablePhControl !== false;
    const heatEnabledMaster = this.config.enableHeatpumpControl !== false;
    const chlorEnabledMaster = this.config.enableChlorControl !== false;

    const pumpOn = await this.getBool(this.config.circulationPumpSocketStateId);
    const pumpScheduleActive = typeof this.isPumpScheduleActive === 'function' ? this.isPumpScheduleActive(new Date()) : false;
    const chlorOnRaw = await this.getBool(this.config.chlorinatorSocketStateId);
    const phPumpOn = await this.getBool(this.config.phPumpSocketStateId);
    const threshold = parseNum(this.config.heatEnableFeedInThresholdW || 1000);

    const orpOnThreshold = parseNum(this.config.orpOnThreshold || 725);
    const orpOffThreshold = parseNum(this.config.orpOffThreshold || 750);

    let chlorDesired = chlorOnRaw;
    let chlorDecision = '';
    if (!chlorEnabledMaster) {
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
    if (!pumpOn) {
      heatDecision = 'Umwälzpumpe AUS';
    } else if (parseNum(feedIn) < threshold) {
      heatDecision = `PV zu gering (${feedIn}W < ${threshold}W)`;
    } else if (parseNum(poolTemp) >= parseNum(targetTemp)) {
      heatDecision = 'Solltemperatur erreicht';
    } else {
      heatDecision = `PV OK (${feedIn}W > ${threshold}W)`;
    }

    const heatpumpOn = await this.getBool(this.config.heatpumpPowerStateId);

    const stableData = {
      ph, orp, poolTemp, outsideTemp, pv, feedIn, gridSupply, battery, targetTemp, heatReason, volume,
      phSet: this.fmt(parseNum(this.config.phSetpoint), 2, '--'),
      phTimes: this.config.phCheckTimes || '-',
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

  async subscribeConfiguredStates() {
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
      'poolsteuerung.0.status.heatpump.lastReason'
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
    if (!circulationOn) {
      await this.setPhStopAtTs(0, 'Start abgebrochen: Umwälzpumpe AUS');
      if (this.config.debugMode) this.log.info('[PH] Dosierung nicht gestartet: Umwälzpumpe AUS');
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
    const circulationEnabled = this.config.enableCirculationControl !== false;
    const phEnabledMaster = this.config.enablePhControl !== false;
    const heatEnabledMaster = this.config.enableHeatpumpControl !== false;
    const chlorEnabledMaster = this.config.enableChlorControl !== false;
    const pumpTarget = circulationEnabled ? this.isPumpScheduleActive(now) : false;
    const pumpState = await this.getStateSnapshot(pumpId);
    const pumpCurrent = !!(pumpState && pumpState.val);
    this.updateCirculationPumpRuntime(pumpCurrent, pumpState && (pumpState.lc || pumpState.ts));

    await this.ensureState('status.debug.lastPumpScheduleActive', 'boolean', 'indicator', false, false);
    await this.ensureState('status.debug.lastPumpLoggedDecision', 'string', 'text', '', false);
    const lastScheduleActive = this.lastPumpScheduleActiveMemory === null ? pumpTarget : this.lastPumpScheduleActiveMemory;
    const scheduleEdge = pumpTarget !== lastScheduleActive;
    const nowMs = now.getTime();

    let pumpDecision = !circulationEnabled ? 'Steuerung deaktiviert' : (pumpTarget ? 'Zeitfenster aktiv' : 'Kein aktives Zeitfenster');

    if (!circulationEnabled) {
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

    const orpValue = await this.getNumber(this.config.orpStateId, 0);
    const chlorId = this.config.chlorinatorSocketStateId;
    const chlorCurrent = await this.getBool(chlorId);
    const orpOnThreshold = parseNum(this.config.orpOnThreshold || 725);
    const orpOffThreshold = parseNum(this.config.orpOffThreshold || 750);
    const chlorDelaySec = Math.max(0, parseNum(this.config.chlorPumpStartDelaySec || 0));
    const pumpOnForSec = this.getPumpOnForSec(nowMs);
    let chlorDecision = 'keine Prüfung';
    let chlorTarget = chlorCurrent;

    if (!chlorEnabledMaster) {
      chlorDecision = chlorCurrent ? 'Steuerung deaktiviert (bleibt EIN)' : 'Steuerung deaktiviert';
    } else if (!pumpCurrent) {
      chlorTarget = false;
      chlorDecision = 'Pumpe AUS';
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

    if (!this.config.simulateMode && (phPumpCurrent || phDoseActive) && (!pumpCurrent || (stopAtTs && Date.now() >= stopAtTs))) {
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
    if (!phEnabled) {
      phDecision = 'pH Freigabe AUS';
    } else if (!pumpCurrent) {
      phDecision = (phPumpCurrent || phDoseActive) ? 'PH-Dosierung gestoppt (Umwälzpumpe AUS)' : 'Pumpe AUS';
    } else if (!this.isPhCheckDue(now)) {
      phDecision = `warte auf Prüfzeit (${this.config.phCheckTimes || '-'})`;
    } else if (phValue === null || !Number.isFinite(phValue)) {
      phDecision = 'pH ungültig';
    } else if (dailyCount >= doseMaxPerDay) {
      phDecision = `Tageslimit erreicht (${dailyCount}/${doseMaxPerDay})`;
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

      if ((phPumpCurrent || (this.phDoseStopAtTsMemory && Date.now() < this.phDoseStopAtTsMemory + 60000))
          && (!pumpCurrent || Date.now() >= stopAtTs)) {
        const offOk = await this.forceSwitchOffCompat(phPumpId);
        if (offOk) {
          await this.setPhStopAtTs(0, !pumpCurrent ? 'PH-AUS bestätigt wegen Umwälzpumpe AUS' : 'PH-AUS bestätigt wegen Sollzeit');
          this.phDoseStopAtTsMemory = 0;
          this.lastWrittenPhStopAtTs = 0;
          this.log.info(`[PH] Dosierpumpe AUS | Grund ${!pumpCurrent ? 'Umwälzpumpe AUS' : 'Sollzeit erreicht'}`);
        } else if (this.config.debugMode) {
          this.log.warn(`[PH] Dosierpumpe AUS fehlgeschlagen | Grund ${!pumpCurrent ? 'Umwälzpumpe AUS' : 'Sollzeit erreicht'}`);
        }
      }
    } catch (e) {
      this.log.warn('[PH] Stop-Überwachung fehlgeschlagen: ' + (e.message || e));
    }
  }



  async onReady() {
    try {
      await this.ensureState('info.connection', 'boolean', 'indicator.connected', false, false);
      await this.ensureState('status.debug.lastCycle', 'string', 'text', '', false);
      await this.ensureState('status.debug.lastStartupError', 'string', 'text', '', false);
      await this.setStateAsync('info.connection', true, true);
      await this.subscribeConfiguredStates();
      if (this.config.circulationPumpSocketStateId) {
        const initialPumpState = await this.getStateSnapshot(this.config.circulationPumpSocketStateId);
        this.updateCirculationPumpRuntime(!!(initialPumpState && initialPumpState.val), initialPumpState && (initialPumpState.lc || initialPumpState.ts));
      }
      await this.updateComputedStates();
      if (typeof this.applyControlLogic === 'function') {
        await this.applyControlLogic();
      }
      await this.renderVis();
      await this.logStartupSummary();
      const pollMin = Math.max(1, Number(this.config.pollIntervalMin) || 1);
      if (this.phStopWatcher) clearInterval(this.phStopWatcher);
    this.phStopWatcher = setInterval(async () => {
      await this.enforcePhStopIfDue();
    }, 1000);

    this.timer = setInterval(async () => {
        try {
          await this.setStateAsync('status.debug.lastCycle', new Date().toISOString(), true);
          await this.updateComputedStates();
          if (typeof this.applyControlLogic === 'function') {
            await this.applyControlLogic();
          }
          await this.renderVis();
        } catch (e) {
          this.log.error(`Poll-Fehler: ${e && e.stack ? e.stack : e}`);
          await this.setStateAsync('status.debug.lastStartupError', String(e && e.message ? e.message : e), true);
        }
      }, pollMin * 60000);
      this.debug(`VIS-HTML aktiv: poolsteuerung.0.vis.htmlTablet / htmlPhone, Poll=${pollMin}min`);
    } catch (e) {
      this.log.error(`Startfehler: ${e && e.stack ? e.stack : e}`);
      try { await this.setStateAsync('status.debug.lastStartupError', String(e && e.message ? e.message : e), true); } catch {}
    }
  }

  async onStateChange(id, state) {
    if (!state) return;
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

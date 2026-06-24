'use strict';
const utils = require('@iobroker/adapter-core');

function parseNum(v) {
  if (v === undefined || v === null || v === '') return 0;
  return Number(String(v).replace(',', '.'));
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inWindow(now, startHHMM, endHHMM) {
  const parseHHMM = (v) => {
    const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  };
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  if (start === null || end === null) return false;
  if (start === 0 && end === 0) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}


class Poolsteuerung extends utils.Adapter {

  lastTabletHtml = '';
  lastPhoneHtml = '';
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
  lastPhPumpOn = false;
  phManualStartedAt = 0;
  phManagedActive = false;
  trendCache = { ts: 0, data: null };
  controlTransitionUntil = 0;

  constructor(options = {}) {
    super({ ...options, name: 'poolsteuerung' });
    this.timer = null;
    this.monitoredIds = [];
    this.renderQueued = false;
    this.lastWrittenPhStopAtTs = null;
    this.phDoseStopAtTsMemory = 0;
    this.phLastDoseTsMemory = 0;
    this.phLastDoseDurationSecMemory = 0;
    this.isShuttingDown = false;
    this.pendingTimeouts = new Set();
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  debug(msg) {
    if (this.config.debugMode) this.log.debug('[DEBUG] ' + msg);
  }

  trackTimeout(handle) {
    this.pendingTimeouts.add(handle);
    return handle;
  }

  clearTrackedTimeout(handle) {
    try { clearTimeout(handle); } catch {}
    this.pendingTimeouts.delete(handle);
  }

  beginControlTransition(ms = 3500) {
    this.controlTransitionUntil = Date.now() + Math.max(500, Number(ms) || 3500);
  }

  isControlTransitionActive() {
    return Date.now() < (Number(this.controlTransitionUntil) || 0);
  }

  isDbClosedError(e) {
    const msg = String((e && (e.message || e.stack || e)) || '');
    return msg.includes('DB closed') || msg.includes('Connection is closed') || msg.includes('connection is closed');
  }

  async forceImmediateRender() {
    if (this.isShuttingDown) return;
    try {
      await this.updateComputedStates();
      if (typeof this.applyControlLogic === 'function') {
        await this.applyControlLogic();
        await this.syncControlStates();
        await this.syncDeviceControlStates();
      }
      this.lastRenderSignature = '';
      this.lastRenderAt = 0;
      await this.renderVis();
    } catch (e) {
      if (!this.isDbClosedError(e)) this.log.warn('VIS Sofort-Render Fehler: ' + (e && e.stack ? e.stack : e));
    }
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
      const val = s ? s.val : undefined;
      if (typeof val === 'boolean') return val;
      if (typeof val === 'number') return val !== 0;
      const str = String(val ?? '').trim().toLowerCase();
      if (!str) return false;
      if (['true', '1', 'on', 'ein', 'yes', 'ja'].includes(str)) return true;
      if (['false', '0', 'off', 'aus', 'no', 'nein'].includes(str)) return false;
      return !!val;
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


  getDeviceSyncInfo(state, maxAgeSec = 180) {
    const ts = Number((state && (state.lc || state.ts)) || 0);
    if (!ts) {
      return { cls: 'bad', label: 'KEIN', ageSec: null };
    }
    const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (ageSec > Math.max(30, Number(maxAgeSec) || 180)) {
      return { cls: 'warn', label: ageSec >= 3600 ? `${Math.floor(ageSec/3600)}h` : `${Math.max(1, Math.floor(ageSec/60))}m`, ageSec };
    }
    return { cls: 'ok', label: ageSec <= 9 ? `${ageSec}s` : `${Math.floor(ageSec/10)*10}s`, ageSec };
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
      ['WP', this.config.heatpumpHeartbeatStateId, this.config.heatpumpHeartbeatMaxAgeMin, 'status.checks.heatpump']
    ];

    for (const [label, stateId, maxAgeMin, targetId] of checks) {
      await this.ensureState(targetId, 'string', 'text', '', false);
      const prevState = await this.getStateAsync(targetId);
      const prevText = String((prevState && prevState.val) || '').trim();
      const result = await this.evaluateHeartbeat(label, stateId, maxAgeMin);
      await this.setStateIfChanged(targetId, result.text, true);

      const changed = prevText !== result.text;
      if (stateId && (Number(maxAgeMin) || 0) > 0 && changed) {
        if (result.severity === 'error' || result.severity === 'warn') {
          this.log.warn(`[CHECK] ${result.text}`);
        } else if (this.config.debugMode) {
          this.log.info(`[CHECK] ${result.text}`);
        }
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

  getTasmotaZigbeeWriteTarget(id) {
    const s = String(id || '');
    const m = s.match(/^(.*)\.ZbReceived_(0x[0-9A-Fa-f]+)_Power$/);
    if (m) {
      return {
        cmdId: `${m[1]}.ZbSend`,
        device: m[2]
      };
    }
    return null;
  }

  isSingleWriteDevice(id) {
    const s = String(id || '');
    return s.startsWith('tuya.') || s === String(this.config.heatpumpPowerStateId || '');
  }

  async waitForBoolState(id, expected, waits = [500, 1000, 1500, 2500]) {
    for (const waitMs of waits) {
      try {
        await new Promise(resolve => setTimeout(resolve, waitMs));
        const current = await this.getBool(id);
        if (current === expected) return true;
      } catch {}
    }
    return false;
  }

  resetHeatpumpLocks(reason = '') {
    const suffix = reason ? ` (${reason})` : '';
    this.heatpumpLock = { state: null, lastOnTs: 0, lastOffTs: 0 };
    this.debug('Heatpump-Locks zurückgesetzt' + suffix);
  }

  clearPendingRenderTimeouts(reason = '') {
    const suffix = reason ? ` (${reason})` : '';
    for (const h of Array.from(this.pendingTimeouts)) {
      try { clearTimeout(h); } catch {}
      this.pendingTimeouts.delete(h);
    }
    this.renderQueued = false;
    this.debug('Pending-Timeouts gelöscht' + suffix);
  }

  async setSwitchStateCompat(id, on) {
    if (!id) return;

    const zbTarget = this.getTasmotaZigbeeWriteTarget(id);
    if (zbTarget) {
      const payload = JSON.stringify({
        Device: zbTarget.device,
        Send: { Power: on ? 1 : 0 }
      });
      await this.setForeignStateAsync(zbTarget.cmdId, payload, false);
      return;
    }

    let mode = '';
    if (id === this.config.circulationPumpSocketStateId) mode = this.config.circulationPumpWriteMode || '';
    if (id === this.config.chlorinatorSocketStateId) mode = this.config.chlorinatorWriteMode || '';
    if (id === this.config.phPumpSocketStateId) mode = this.config.phPumpWriteMode || '';
    if (id === this.config.heatpumpPowerStateId) mode = this.config.heatpumpWriteMode || '';
    if (id === this.config.heatpumpPowerStateId) mode = this.config.heatpumpWriteMode || '';

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
    const zbTarget = this.getTasmotaZigbeeWriteTarget(id);
    if (zbTarget) {
      try { await this.setSwitchStateCompat(id, true); } catch {}
      await this.waitForBoolState(id, true, [400, 700, 1000, 1500]);
      return true;
    }

    if (this.isSingleWriteDevice(id)) {
      try { await this.setSwitchStateCompat(id, true); } catch {}
      await this.waitForBoolState(id, true, [500, 1000, 1500, 2500, 3500]);
      return true;
    }

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
    const zbTarget = this.getTasmotaZigbeeWriteTarget(id);
    if (zbTarget) {
      try { await this.setSwitchStateCompat(id, false); } catch {}
      await this.waitForBoolState(id, false, [400, 700, 1000, 1500]);
      return true;
    }

    if (this.isSingleWriteDevice(id)) {
      try { await this.setSwitchStateCompat(id, false); } catch {}
      await this.waitForBoolState(id, false, [500, 1000, 1500, 2500, 3500]);
      return true;
    }

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

  getDerivedHeatpumpAuxStateIds() {
    const powerId = String(this.config.heatpumpPowerStateId || '').trim();
    const match = powerId.match(/^(.*\.)(\d+)$/);
    if (!match) return { speedId: '', modeId: '' };
    return {
      speedId: `${match[1]}104`,
      modeId: `${match[1]}105`,
    };
  }

  formatHeatpumpMode(value) {
    const txt = String(value ?? '').trim();
    if (!txt || txt === '--') return '--';
    const m = txt.match(/^([^()]+)\(([^)]+)\)$/);
    if (m) return `${m[1].trim()} (${m[2].trim()})`;
    return txt;
  }

  fmt(n, digits = 1, fallback = '--') {
    return n === null || n === undefined || !Number.isFinite(n) ? fallback : n.toFixed(digits);
  }

  formatDurationHours(hoursValue, fallback = '--') {
    const hours = Number(hoursValue);
    if (!Number.isFinite(hours)) return fallback;
    const totalMinutes = Math.max(0, Math.round(hours * 60));
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    return `${hh}h ${String(mm).padStart(2, '0')}m`;
  }

  formatGermanDateTime(value, fallback = '--') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(d);
  }

  async getFormattedDateTimeFromState(id, fallback = '--') {
    if (!id) return fallback;
    try {
      const s = await this.getForeignStateAsync(id);
      if (!s) return fallback;
      if (s.val !== undefined && s.val !== null && String(s.val).trim() !== '') {
        return this.formatGermanDateTime(String(s.val), fallback);
      }
      const ts = Number(s.ts || s.lc || 0);
      if (!ts) return fallback;
      return this.formatGermanDateTime(new Date(ts).toISOString(), fallback);
    } catch {
      return fallback;
    }
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
    const poolTempNum = parseNum(data.poolTemp);
    const tempScaleMin = 15;
    const tempScaleMax = 32;
    const tempPct = Number.isFinite(poolTempNum)
      ? Math.max(0, Math.min(100, ((poolTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100))
      : 0;
    const targetTempNum = parseNum(data.targetTemp);
    const targetPct = Number.isFinite(targetTempNum)
      ? Math.max(0, Math.min(100, ((targetTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100))
      : 0;

    const phBadge = !Number.isFinite(phNum)
      ? { cls: 'neutral', txt: '—' }
      : phNum < 7.1 ? { cls: 'low', txt: 'Niedrig' }
      : phNum <= 7.25 ? { cls: 'ok', txt: 'OK' }
      : { cls: 'high', txt: 'Hoch' };

    const orpBadge = !Number.isFinite(orpNum) || !Number.isFinite(orpOnNum) || !Number.isFinite(orpOffNum)
      ? { cls: 'neutral', txt: '—' }
      : orpNum < orpOnNum ? { cls: 'low', txt: 'Niedrig' }
      : orpNum > orpOffNum ? { cls: 'high', txt: 'Hoch' }
      : { cls: 'ok', txt: 'OK' };

    const kv = (label, value, extraCls = '') => `
      <div class="kv ${extraCls}">
        <div class="kv-label">${esc(label)}</div>
        <div class="kv-value">${esc(value)}</div>
      </div>`;

    const status = (name, hint, on, syncCls = 'warn', syncLabel = '?') => `
      <div class="status-row ${on ? 'status-on' : 'status-off'}">
        <div class="status-left">
          <div class="status-name">${esc(name)}</div>
          <div class="status-hint">${esc(hint)}</div>
        </div>
        <div class="status-right">
          <div class="sync-badge ${esc(syncCls)}">${esc(syncLabel)}</div>
          <div class="pill ${on ? 'on' : 'off'}">${on ? 'EIN' : 'AUS'}</div>
        </div>
      </div>`;

    const trendClass = trend => trend === '↑' ? 'up' : (trend === '↓' ? 'down' : 'flat');
    const phClass = phBadge && phBadge.cls ? phBadge.cls : '';
    const orpClass = orpBadge && orpBadge.cls ? orpBadge.cls : '';
    const metric = (label, value, sub = '', badge = null, accent = '', trend = '', trendOk = false, trendBad = false) => `
      <div class="metric ${accent}">
        <div class="metric-label">${esc(label)}</div>
        <div class="metric-value">
          <span class="metric-main ${trendOk ? 'ok' : (trendBad ? 'bad' : '')}">${esc(value)}</span>
          ${trend ? `<span class="metric-trend ${trendClass(trend)} ${trendOk ? 'ok' : (trendBad ? 'bad' : '')}">${esc(trend)}</span>` : ''}
        </div>
        ${sub ? `<div class="metric-sub">${esc(sub)}</div>` : ''}
        ${badge ? `<div class="badge ${badge.cls}">${badge.txt}</div>` : ''}
      </div>`;

    const mini = (label, value, accent = '') => `
      <div class="mini ${accent}">
        <div class="mini-label">${esc(label)}</div>
        <div class="mini-value">${esc(value)}</div>
      </div>`;

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root{
  --bg:#08121f;--bg2:#0f1d34;--line:rgba(255,255,255,.08);
  --txt:#f7fbff;--muted:#b6c4d8;--accent:#55c8ff;--accent2:#6a7cff;
  --green:#57d96e;--orange:#ffb347;--red:#ff7668;--cyan:#62d8ff;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  font-family:Arial,Helvetica,sans-serif;color:var(--txt);
  background:
    radial-gradient(circle at top left, rgba(85,200,255,.16), transparent 25%),
    radial-gradient(circle at bottom right, rgba(106,124,255,.13), transparent 22%),
    linear-gradient(180deg,var(--bg2),var(--bg));
}
.wrap{width:100%;max-width:1000px;height:730px;max-height:730px;padding:6px;overflow:hidden;margin:0 auto}
.layout{display:flex;gap:8px;align-items:flex-start;width:100%;height:718px;max-height:718px;overflow:hidden}
.col-left{flex:0 0 28%}
.col-mid{flex:0 0 34%}
.col-right{flex:1 1 0}
.card{
  background:linear-gradient(180deg,rgba(15,32,57,.96),rgba(10,24,44,.98));
  border:1px solid var(--line);border-radius:18px;padding:10px;overflow:hidden;
  box-shadow:0 18px 40px rgba(0,0,0,.28)
}
.hero{
  background:
    radial-gradient(circle at top right, rgba(82,199,255,.22), transparent 28%),
    linear-gradient(180deg,rgba(23,46,80,.97),rgba(11,26,48,.98));
  min-height:330px;
  border-color:rgba(86,196,255,.18);
}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.title{font-size:15px;font-weight:900;letter-spacing:.2px}
.meta{text-align:right;font-size:10px;color:var(--muted);line-height:1.15;max-width:86px}
.mode{display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;border-radius:999px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:9px;font-weight:900;margin-bottom:6px;box-shadow:0 6px 18px rgba(88,172,255,.25)}
.temp-wrap{margin:18px 0 6px;display:flex;align-items:flex-end;gap:8px}
.temp{font-size:68px;font-weight:900;line-height:.9}
.unit{font-size:16px;color:#d4e5f6;padding-bottom:7px}
.temp-scale{margin:6px 0 10px}
.scale-row{display:flex;justify-content:space-between;font-size:11px;color:#c7d6ea;margin-top:6px}
.scale-track{position:relative;height:8px;border-radius:999px;background:linear-gradient(90deg,#46b3ff 0%, #58d27a 55%, #f5c04f 78%, #ff7f6f 100%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
.scale-target{position:absolute;top:50%;left:${targetPct}%;width:3px;height:18px;border-radius:999px;background:#ffffff;box-shadow:0 0 0 1px rgba(15,33,60,.65), 0 0 0 2px rgba(255,255,255,.15);transform:translate(-50%,-50%)}
.scale-dot{position:absolute;top:50%;width:13px;height:13px;border-radius:50%;background:#fff;border:3px solid #0f213c;box-shadow:0 0 0 3px rgba(255,255,255,.25), 0 4px 12px rgba(0,0,0,.35);transform:translate(-50%,-50%);left:${tempPct}%}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px}
.metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:9px;min-height:78px;position:relative}
.metric.cool{background:linear-gradient(180deg,rgba(80,166,255,.15),rgba(255,255,255,.05))}
.metric.warn{background:linear-gradient(180deg,rgba(255,145,96,.12),rgba(255,255,255,.05))}
.metric-target{background:linear-gradient(180deg,rgba(86,217,120,.10),rgba(255,255,255,.05))}
.metric-label{font-size:12px;color:#c8d4e6;font-weight:800;margin-bottom:6px}
.metric-value{font-size:17px;font-weight:900;line-height:1.05;display:flex;align-items:center;gap:8px}
.metric-main.ok{color:#67dd7c}.metric-main.bad{color:#ff7a6a}
.metric-trend{display:inline-flex;min-width:18px;justify-content:center;font-size:20px;font-weight:900;line-height:1;margin-left:10px}
.metric-trend.up{color:#ffb36b}.metric-trend.down{color:#7dd3fc}.metric-trend.flat{color:#d5e4f8}.metric-trend.ok{color:#67dd7c}.metric-trend.bad{color:#ff7a6a}
.metric-sub{font-size:10px;color:#aebed5;margin-top:4px}
.badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;margin-top:8px;font-size:11px;font-weight:900}
.badge.ok{background:rgba(64,196,99,.18);color:#9ff5b3}
.badge.low{background:rgba(255,176,32,.18);color:#ffd480}
.badge.high{background:rgba(255,107,87,.18);color:#ffc0b7}
.badge.neutral{background:rgba(148,163,184,.18);color:#d8e1ec}
.section{font-size:15px;font-weight:900;margin-bottom:8px}
.section.energy{color:#8eddff}
.section.status{color:#89ffa7}
.section.extra{color:#ffd37d}
.stack{display:grid;gap:5px}
.kv{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.05);border-radius:12px;padding:6px}
.kv.energy{background:linear-gradient(90deg,rgba(68,171,255,.10),rgba(255,255,255,.04))}
.kv.auto{background:linear-gradient(90deg,rgba(109,128,255,.14),rgba(255,255,255,.04))}
.kv.reason{background:linear-gradient(90deg,rgba(94,210,158,.11),rgba(255,255,255,.04))}
.kv-label{font-size:12px;color:#c6d7ea;font-weight:800;max-width:42%}
.kv-value{font-size:13px;font-weight:900;line-height:1.15;text-align:right;word-break:break-word;max-width:58%}
.status-card{margin-bottom:10px}
.status-list{display:grid;gap:6px}
.status-row{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.05);border-radius:12px;padding:6px}
.status-on{background:linear-gradient(90deg,rgba(78,204,102,.10),rgba(255,255,255,.04))}
.status-off{background:linear-gradient(90deg,rgba(255,108,95,.10),rgba(255,255,255,.04))}
.status-left{min-width:0;max-width:calc(100% - 86px)}
.status-name{font-size:13px;font-weight:900;line-height:1.1}
.status-hint{font-size:10px;color:#aebed5;margin-top:2px}
.pill{min-width:64px;text-align:center;padding:7px 8px;border-radius:999px;font-size:9px;font-weight:900;color:#fff;flex:0 0 auto}
.pill.on{background:linear-gradient(180deg,#56d56e,#36b357);box-shadow:0 8px 18px rgba(56,179,87,.25)}
.pill.off{background:linear-gradient(180deg,#f36e62,#df4a3d);box-shadow:0 8px 18px rgba(223,74,61,.25)}
.mini-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}
.mini{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.05);border-radius:14px;padding:9px}
.mini.info{background:linear-gradient(180deg,rgba(90,166,255,.09),rgba(255,255,255,.04))}
.mini.highlight{background:linear-gradient(180deg,rgba(255,190,76,.11),rgba(255,255,255,.04))}
.mini-label{font-size:12px;color:#c8d7eb;font-weight:800;margin-bottom:6px}
.mini-value{font-size:13px;font-weight:900;line-height:1.1}
.manual-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:10px 12px;border-radius:14px;min-height:52px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}
.manual-btn span{font-size:20px}
.manual-btn small{font-size:12px;color:#dbeafe}
@media (max-width:1100px){
  .layout{display:block}
  .col-left,.col-mid,.col-right{width:auto}
  .col-mid,.col-right{margin-top:14px}
}
</style></head><body><div class="wrap"><div class="layout">
  <div class="col-left">
    <div class="card hero">
      <div class="head">
        <div class="title">Pool Manager <span class="ver">${esc(data.adapterVersion)}</span></div>
        <div class="meta">
          <div class="mode">${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}</div><br>
          Aktualisiert<br>${esc(data.updated)}
        </div>
      </div>
      <div class="temp-wrap">
        <div class="temp">${esc(data.poolTemp)}</div>
        <div class="unit">°C</div>
      </div>
      <div class="temp-scale">
        <div class="scale-track"><div class="scale-target" title="Soll ${esc(data.targetTemp)} °C"></div><div class="scale-dot"></div></div>
        <div class="scale-row"><span>15 °C</span><span>Aktuell: ${esc(data.poolTemp)} °C</span><span>32 °C</span></div>
      </div>
      <div class="metrics">
        ${metric('pH', data.ph, `Soll ${data.phSet}`, phBadge, 'warn', data.phTrend || '→', phClass === 'ok', phClass === 'low' || phClass === 'high')}
        ${metric('ORP', data.orp, `Soll ${data.orpSet}`, orpBadge, 'warn', data.orpTrend || '→', orpClass === 'ok', orpClass === 'low' || orpClass === 'high')}
        ${metric('Außen', `${data.outsideTemp}°C`, 'Außen', null, 'cool', data.outsideTempTrend || '→', false)}
        ${metric('Solltemp', `${data.targetTemp}°C`, 'Soll', null, 'metric-target')}
      </div>
    </div>
    <div class="card">
      <div class="section energy">Auto & Wallbox</div>
      <div class="mini-list">
        ${mini('Status', data.wallboxChargingStatus, data.wallboxCharging ? 'highlight' : 'info')}
        ${mini('Stecker', data.wallboxPlugStatus, 'info')}
        ${mini('Leistung', `${data.wallboxPowerKw} kW`, 'highlight')}
        ${mini('SoC', `${data.wallboxSoc} % / ${data.wallboxTargetSoc} %`, 'highlight')}
        ${mini('Restzeit', data.wallboxTimeToFull, 'info')}
        ${mini('Reichweite', `${data.wallboxRangeKm} km`, 'info')}
      </div>
      <div style="margin-top:10px;font-size:11px;color:#64748b;line-height:1.45;">
        Stand: ${esc(data.wallboxTibberLastSeen || '--')}
      </div>
    </div>
  </div>

  <div class="col-mid">
    <div class="card">
      <div class="section energy">Schnellzugriff</div>
      <div class="mini-list">
        ${mini('Poolsolltemperatur', `${data.targetTemp} °C`, 'info')}
        <button type="button" class="manual-btn js-manual-dose-btn" data-sec="${Number(data.manualDoseButtonSec || 30) || 30}" style="min-height:64px;"><span>PH Manuell</span><small>${esc(data.manualDoseButtonSec || 30)} Sek.</small></button>
      </div>
    </div>
    <div class="card">
      <div class="section energy">Energie & Steuerung</div>
      <div class="stack">
        ${kv('Pumpe Auto', data.autoCirculation, 'auto')}
        ${kv('Chlor Auto', data.autoChlor, 'auto')}
        ${kv('pH Auto', data.autoPh, 'auto')}
        ${kv('WP Auto', data.autoHeatpump, 'auto')}
        ${kv('PV-Leistung', `${data.pv} W`, 'energy')}
        ${kv('Netzeinspeisung', `${data.feedIn} W`, 'energy')}
        ${kv('Netzbezug', `${data.gridSupply} W`, 'energy')}
        ${kv('Batterie SoC', `${data.battery} %`, 'energy')}
        ${kv('WP Freigabe', data.heatReason, 'reason')}
        ${kv('Chlor Freigabe', data.chlorDecision, 'reason')}
        ${kv('Zeitplan', data.pumpDecision, 'reason')}
        ${kv('pH Prüfung', data.phDecision, 'reason')}
        ${kv('pH Zeiten', data.phTimes)}
        ${kv('Standby nächster Lauf', data.standbyNext)}
        ${kv('Letzte Dosierung', `${data.phLastDoseDurationSec} s`)}
      </div>
    </div>
  </div>

  <div class="col-right">
    <div class="card status-card">
      <div class="section status">Aktoren & Status</div>
      <div class="status-list">
        ${status('Umwälzpumpe', 'IST-Zustand', data.pumpOn, data.pumpSyncCls, data.pumpSyncLabel)}
        ${status('Chlorinator', 'ORP-Regelung', data.chlorOn, data.chlorSyncCls, data.chlorSyncLabel)}
        ${status('pH-Dosierpumpe', 'Prüfzeiten', data.phPumpOn, data.phPumpSyncCls, data.phPumpSyncLabel)}
        ${status('Wärmepumpe', 'PV-Freigabe', data.heatpumpOn, data.heatpumpSyncCls, data.heatpumpSyncLabel)}
      </div>
    </div>
    <div class="card">
      <div class="section extra">Zusatzwerte</div>
      <div class="mini-list">
        ${mini('Zeitplan', data.pumpScheduleActive ? 'AKTIV' : 'INAKTIV', 'highlight')}
        ${mini('PV Schwelle', `${data.threshold} W`, 'info')}
        ${mini('ORP Grenzen', `${data.orpOnThreshold} / ${data.orpOffThreshold}`, 'highlight')}
        ${mini('pH Tag', `${data.phDailyCount}`, 'info')}
        ${mini('Pumpe ml/min', `${data.phFlowMlMin}`, 'info')}
        ${mini('ml je 0,1 / 10m³', `${data.phMlPer01Per10}`, 'info')}
        ${mini('Poolvolumen', `${data.volume} m³`, 'highlight')}
        ${mini('WP Lüfter', String(data.heatpumpFanPercent ?? '--'), 'info')}
        ${mini('WP Modus', data.heatpumpMode || '--', 'highlight')}
        ${mini('Granulat manuell', data.manualGranulateText, 'highlight')}
      </div>
    </div>
  </div>
<script>
(function(){
  function getVisApi(){
    try{ if(window.vis) return window.vis; }catch(e){}
    try{ if(window.parent&&window.parent.vis) return window.parent.vis; }catch(e){}
    try{ if(window.top&&window.top.vis) return window.top.vis; }catch(e){}
    return null;
  }
  function getConn(){
    try{ const v=getVisApi(); if(v&&v.conn&&typeof v.conn.setState==='function') return v.conn; }catch(e){}
    return null;
  }
  window.poolSetState = async function(id,val){
    const v=getVisApi();
    const conn=getConn();
    try{
      if(v && typeof v.setValue === 'function'){
        const r=v.setValue(id,val);
        if(r && typeof r.then==='function'){ await r; }
        return true;
      }
    }catch(e){}
    if(!conn) return false;
    const attempts = [
      () => conn.setState(id,val),
      () => conn.setState(id,val,false),
      () => conn.setState(id,val,()=>{}),
      () => conn.setState(id,val,false,()=>{})
    ];
    for(const fn of attempts){
      try{
        const r=fn();
        if(r && typeof r.then==='function'){ await r; }
        return true;
      }catch(e){}
    }
    return false;
  };
  window.poolToggleControl = async function(key,current){
    const ns=${JSON.stringify(data.namespace)};
    const ok=await window.poolSetState(ns+'.control.auto.'+key, !current);
    if(!ok) alert('VIS setState nicht verfügbar');
  };
  window.poolPhManualDose = async function(sec){
    const ns=${JSON.stringify(data.namespace)};
    await window.poolSetState(ns + '.control.ph.manualDoseSec', Number(sec) || 30);
    const ok=await window.poolSetState(ns + '.control.ph.manualTrigger', Date.now());
    if(!ok) alert('VIS setState nicht verfügbar');
  };
  const bindOne = (selector, handler) => {
    document.querySelectorAll(selector).forEach(el => {
      const run = (ev) => {
        try{ if(ev){ ev.preventDefault(); ev.stopPropagation(); } }catch(e){}
        const now = Date.now();
        const last = Number(el.dataset.lastTapTs || 0);
        if (now - last < 700) return false;
        el.dataset.lastTapTs = String(now);
        handler(el);
        return false;
      };
      try{ el.addEventListener('touchend', run, {passive:false}); }catch(e){}
      try{ el.addEventListener('click', run, false); }catch(e){}
      try{ el.style.cursor = 'pointer'; }catch(e){}
    });
  };
  const bind = () => {
    bindOne('.js-auto-btn', el => window.poolToggleControl(el.dataset.key, el.dataset.current === '1'));
    bindOne('.js-device-btn', el => window.poolToggleState(el.dataset.key || '', el.dataset.current === '1'));
    bindOne('.js-standby-btn', el => window.poolToggleStandby(el.dataset.current === '1'));
    bindOne('.js-manual-dose-btn', el => window.poolPhManualDose(Number(el.dataset.sec || 30)));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
</script></body></html>`;
  }

  buildPhoneHtml(data) {
    const poolTempNum = parseNum(data.poolTemp);
    const tempScaleMin = 15;
    const tempScaleMax = 32;
    const tempPct = Number.isFinite(poolTempNum) ? Math.max(0, Math.min(100, ((poolTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100)) : 0;
    const targetTempNum = parseNum(data.targetTemp);
    const targetPct = Number.isFinite(targetTempNum) ? Math.max(0, Math.min(100, ((targetTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100)) : 0;
    const autoBtn = (label, key, active) => `<button type="button" class="action-btn js-auto-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="action-name">${esc(label)}</span><span class="action-state">${active ? 'AKTIV' : 'AUS'}</span></button>`;
    const deviceBtn = (label, key, active, syncCls = 'warn', syncLabel = '?') => `<button type="button" class="action-btn js-device-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="action-sync ${esc(syncCls)}">${esc(syncLabel)}</span><span class="action-name">${esc(label)}</span><span class="action-state">${active ? 'EIN' : 'AUS'}</span></button>`;
    const trendClass = trend => trend === '↑' ? 'up' : (trend === '↓' ? 'down' : 'flat');
    const phClass = data.phBadge && data.phBadge.cls ? data.phBadge.cls : '';
    const orpClass = data.orpBadge && data.orpBadge.cls ? data.orpBadge.cls : '';
    const quick = (label, value, trend = '', barHtml = '') => `
      <div class="quick-card">
        <div class="quick-label">${esc(label)}</div>
        <div class="quick-value-row">
          <div class="quick-value">${esc(value)}</div>
          ${trend ? `<div class="quick-trend ${trendClass(trend)}">${esc(trend)}</div>` : ''}
        </div>
        ${barHtml || ''}
      </div>`;
    const metricValue = (value, trend = '→', ok = false) => `<span class="metric-main ${ok ? 'ok' : ''}">${esc(value)}</span><span class="trend ${trendClass(trend)} ${ok ? 'ok' : ''}" style="margin-left:10px;font-weight:900;font-size:18px;">${esc(trend)}</span>`;
    const batteryPct = Math.max(0, Math.min(100, parseNum(data.battery)));
    const batteryBar = `<div class="mini-bar"><div class="mini-fill battery-fill" style="width:${batteryPct}%"></div></div>`;

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<style>
:root{--bg:#08111f;--bg2:#10203a;--line:rgba(15,23,42,.08);--text:#0f172a;--muted:#66758a}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at top left, rgba(89,188,255,.18), transparent 28%),linear-gradient(180deg,var(--bg2),var(--bg));font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:var(--text)}
.wrap{width:100%;max-width:510px;min-height:100vh;overflow:visible;margin:0 auto;padding:4px 4px 64px;display:grid;gap:4px;align-content:start}
.card{background:linear-gradient(180deg,#ffffff 0%,#eef5ff 100%);border:1px solid var(--line);border-radius:14px;padding:6px;box-shadow:0 6px 14px rgba(0,0,0,.12)}
.hero{background:radial-gradient(circle at top right, rgba(85,200,255,.24), transparent 26%),linear-gradient(180deg,#1b3763 0%,#0f2343 100%);color:#fff;border-color:rgba(255,255,255,.10)}
.header{display:flex;justify-content:space-between;gap:6px;align-items:flex-start}
.title{font-size:17px;font-weight:900}.ver{font-size:9px;font-weight:800;color:#b9d7ff;margin-left:5px}
.meta{font-size:9px;color:#d2dded;text-align:right;line-height:1.05}.mode-badge{display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:linear-gradient(180deg,#334f84,#1b3158);font-size:9px;font-weight:900;color:#fff;margin-bottom:3px}
.temp-row{display:flex;align-items:flex-end;gap:5px;margin:3px 0 4px}.temp{font-size:54px;font-weight:900;line-height:.9}.unit{font-size:17px;padding-bottom:5px;color:#d5e5f6}
.scale{margin:2px 0 4px}.track{position:relative;height:7px;border-radius:999px;background:linear-gradient(90deg,#46b3ff 0%, #58d27a 55%, #f5c04f 78%, #ff7f6f 100%)}.target-mark{position:absolute;top:50%;left:${targetPct}%;width:3px;height:14px;border-radius:999px;background:#ffffff;border:1px solid rgba(17,48,91,.8);transform:translate(-50%,-50%)}.dot{position:absolute;top:50%;left:${tempPct}%;width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid #314a72;transform:translate(-50%,-50%)}.target-label{position:relative;height:12px;font-size:9px;color:#d2dded}.target-label span{position:absolute;left:${targetPct}%;transform:translateX(-50%)}.scale-labels{display:flex;justify-content:space-between;margin-top:3px;font-size:9px;color:#e3edf9}
.metrics,.quick-grid,.auto-grid,.status-grid,.control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
.ph-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:6px}.metric-label{font-size:10px;color:#d9e5f5}.metric-value{font-size:13px;font-weight:900;color:#fff}
.section-title{font-size:12px;font-weight:900;color:#0f172a;margin-bottom:3px;line-height:1.05}
.quick-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:11px;padding:5px}.quick-label{font-size:8px;color:#64748b;font-weight:700;margin-bottom:2px}.quick-value-row{display:flex;align-items:center;gap:6px}.quick-value{font-size:11px;font-weight:900;color:#0f172a;line-height:1.03}.quick-trend{font-size:15px;font-weight:900;line-height:1}.quick-trend.up{color:#ffb36b}.quick-trend.down{color:#52b7ff}.quick-trend.flat{color:#8fa3bc}.mini-bar{margin-top:4px;height:6px;border-radius:999px;background:linear-gradient(90deg,#ff6b6b 0%,#f59e0b 35%,#84cc16 65%,#22c55e 100%);position:relative;overflow:hidden}.mini-fill{height:100%;border-radius:999px}.battery-fill{background:linear-gradient(90deg,rgba(255,255,255,.28),rgba(255,255,255,.12));box-shadow:inset 0 0 0 999px rgba(255,255,255,.10)}
.action-btn{appearance:none;border:none;cursor:pointer;text-align:left;padding:8px 10px;border-radius:12px;min-height:46px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 6px 14px rgba(6,24,44,.22);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;gap:3px}
.action-name{font-size:12px;font-weight:800}.action-state{font-size:9px;font-weight:800}
.action-btn.is-on .action-name,.action-btn.is-on .action-state{color:#67dd7c}
.action-btn.is-off .action-name,.action-btn.is-off .action-state{color:#ff8d7b}
.manual-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:8px 10px;border-radius:999px;min-height:42px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 6px 14px rgba(6,24,44,.22);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}
.manual-btn span{font-size:12px}.manual-btn small{font-size:8px;color:#dbeafe}
.temp-btn{appearance:none;border:none;cursor:pointer;border-radius:12px;min-height:52px;padding:8px 10px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:16px}
.temp-center{display:flex;flex-direction:column;justify-content:center;align-items:center;background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:6px}
.temp-center .quick-label{margin-bottom:1px}
.temp-center .quick-value{font-size:16px}
</style>
</head><body><div class="wrap">
  <div class="card hero">
    <div class="header"><div class="title">Pool Manager <span class="ver">${esc(data.adapterVersion)}</span></div><div class="meta"><div class="mode-badge">${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}</div><br>Aktualisiert<br>${esc(data.updated)}</div></div>
    <div class="temp-row"><div class="temp">${esc(data.poolTemp)}</div><div class="unit">°C</div></div>
    <div class="scale"><div class="track"><div class="target-mark"></div><div class="dot"></div></div><div class="target-label"><span>Soll ${esc(data.targetTemp)}°C</span></div><div class="scale-labels"><span>15 °C</span><span>32 °C</span></div></div>
    <div class="metrics">
      <div class="metric"><div class="metric-label">pH</div><div class="metric-value">${metricValue(data.ph, data.phTrend, ((data.phBadge && data.phBadge.cls) === 'ok' ? 'ok' : ((((data.phBadge && data.phBadge.cls) === 'warn') || ((data.phBadge && data.phBadge.cls) === 'bad')) ? 'bad' : '')))}</div></div>
      <div class="metric"><div class="metric-label">ORP</div><div class="metric-value">${metricValue(data.orp, data.orpTrend, ((data.orpBadge && data.orpBadge.cls) === 'ok' ? 'ok' : ((((data.orpBadge && data.orpBadge.cls) === 'warn') || ((data.orpBadge && data.orpBadge.cls) === 'bad')) ? 'bad' : '')))}</div></div>
      <div class="metric"><div class="metric-label">Außen</div><div class="metric-value">${metricValue(`${data.outsideTemp}°C`, data.outsideTempTrend, false)}</div></div>
      <div class="metric"><div class="metric-label">Soll</div><div class="metric-value">${esc(data.targetTemp)}°C</div></div>
    </div>
  </div>

  <div class="card" style="min-height:132px;"><div class="section-title">Schnellzugriff</div><div class="control-grid">
    <button type="button" class="action-btn js-standby-btn ${data.standbyControl ? 'is-on' : 'is-off'}" data-current="${data.standbyControl ? '1' : '0'}"><span class="action-name">Standby</span><span class="action-state">${data.standbyControl ? 'AKTIV' : 'AUS'}</span></button>
    <div class="temp-center"><div class="quick-label">Poolsolltemperatur</div><div class="quick-value">${esc(data.targetTemp)}°C</div></div>
    <button type="button" class="manual-btn js-manual-dose-btn" data-sec="${Number(data.manualDoseButtonSec || 30) || 30}" style="grid-column:1 / -1;"><span>PH Manuell</span><small>${esc(data.manualDoseButtonSec || 30)} Sek.</small></button>
  </div></div>

  <div class="card" style="min-height:138px;"><div class="section-title">Automatik</div><div class="auto-grid">
    ${autoBtn('Umwälzpumpe','circulation',!!data.autoCirculationControl)}
    ${autoBtn('Chlor','chlor',!!data.autoChlorControl)}
    ${autoBtn('pH','ph',!!data.autoPhControl)}
    ${autoBtn('Wärmepumpe','heatpump',!!data.autoHeatpumpControl)}
  </div></div>

  <div class="card" style="min-height:138px;"><div class="section-title">Aktoren & Status</div><div class="status-grid">
    ${deviceBtn('Umwälzpumpe','circulation',!!data.pumpOn)}
    ${deviceBtn('Chlorinator','chlorinator',!!data.chlorOn)}
    ${deviceBtn('pH-Dosierpumpe','phPump',!!data.phPumpOn)}
    ${deviceBtn('Wärmepumpe','heatpump',!!data.heatpumpOn)}
  </div></div>

  <div class="card" style="min-height:190px;"><div class="section-title">Energie & Steuerung</div><div class="quick-grid">
    ${quick('PV-Leistung', `${data.pv} W`, data.pvTrend || '→')}
    ${quick('Einspeisung', `${data.feedIn} W`, data.feedInTrend || '→')}
    ${quick('Batterie', `${data.battery} %`, '', batteryBar)}
    ${quick('WP Freigabe', data.heatDecision)}
    ${quick('WP Lüfter', String(data.heatpumpFanPercent ?? '--'))}
    ${quick('WP Modus', data.heatpumpMode || '--')}
    ${quick('Chlor Freigabe', data.chlorDecision)}
    ${quick('pH Prüfung', data.phDecision)}
  </div></div>


</div>
<script>
(function(){
  function getVisApi(){
    try{ if(window.vis) return window.vis; }catch(e){}
    try{ if(window.parent&&window.parent.vis) return window.parent.vis; }catch(e){}
    try{ if(window.top&&window.top.vis) return window.top.vis; }catch(e){}
    return null;
  }
  function getConn(){
    try{ const v=getVisApi(); if(v&&v.conn&&typeof v.conn.setState==='function') return v.conn; }catch(e){}
    return null;
  }
  window.poolSetState = async function(id,val){
    const v=getVisApi();
    const conn=getConn();
    try{
      if(v && typeof v.setValue === 'function'){
        const r=v.setValue(id,val);
        if(r && typeof r.then==='function'){ await r; }
        return true;
      }
    }catch(e){}
    if(!conn) return false;
    const attempts = [
      () => conn.setState(id,val),
      () => conn.setState(id,val,false),
      () => conn.setState(id,val,()=>{}),
      () => conn.setState(id,val,false,()=>{})
    ];
    for(const fn of attempts){
      try{
        const r=fn();
        if(r && typeof r.then==='function'){ await r; }
        return true;
      }catch(e){}
    }
    return false;
  };
  window.poolToggleControl = async function(key,current){
    const ns=${JSON.stringify(data.namespace)};
    const ok=await window.poolSetState(ns+'.control.auto.'+key, !current);
    if(!ok) alert('VIS setState nicht verfügbar');
  };
  window.poolToggleStandby = async function(current){
    const ns=${JSON.stringify(data.namespace)};
    const ok=await window.poolSetState(ns+'.control.standby', !current);
    if(!ok) alert('VIS setState nicht verfügbar');
  };
  window.poolToggleState = async function(key,current){
    const ns=${JSON.stringify(data.namespace)};
    let ctrl='';
    if(key==='circulation') ctrl='.control.device.circulation';
    else if(key==='chlorinator') ctrl='.control.device.chlorinator';
    else if(key==='phPump') ctrl='.control.device.phPump';
    else if(key==='heatpump') ctrl='.control.device.heatpump';
    if(!ctrl){ alert('Kein Control-Key hinterlegt'); return; }
    const ok=await window.poolSetState(ns+ctrl, !current);
    if(!ok) alert('VIS setState nicht verfügbar');
  };
  window.poolPhManualDose = async function(sec){
    const ns=${JSON.stringify(data.namespace)};
    await window.poolSetState(ns + '.control.ph.manualDoseSec', Number(sec) || 30);
    const ok=await window.poolSetState(ns + '.control.ph.manualTrigger', Date.now());
    if(!ok) alert('VIS setState nicht verfügbar');
  };
  window.poolAdjustSetTemp = async function(delta){
    const ns=${JSON.stringify(data.namespace)};
    const hpOn=${data.heatpumpOn ? 'true' : 'false'};
    if(!hpOn){ alert('Solltemperatur nur bei laufender Wärmepumpe änderbar'); return; }
    if(!${JSON.stringify(data.heatpumpSetTempStateId || '')}){ alert('Kein Solltemperatur-State hinterlegt'); return; }
    const current=Number(${JSON.stringify(data.targetTemp)}.replace(',', '.'));
    const next=Math.max(10, Math.min(40, Math.round((current + Number(delta))*10)/10));
    const ok=await window.poolSetState(ns+'.control.heatpump.setTemp', next);
    if(!ok) alert('VIS setState nicht verfügbar');
  };
  const bindOne = (selector, handler) => {
    document.querySelectorAll(selector).forEach(el => {
      const run = (ev) => {
        try{ if(ev){ ev.preventDefault(); ev.stopPropagation(); } }catch(e){}
        const now = Date.now();
        const last = Number(el.dataset.lastTapTs || 0);
        if (now - last < 700) return false;
        el.dataset.lastTapTs = String(now);
        handler(el);
        return false;
      };
      try{ el.addEventListener('touchend', run, {passive:false}); }catch(e){}
      try{ el.addEventListener('click', run, false); }catch(e){}
      try{ el.style.cursor = 'pointer'; }catch(e){}
    });
  };
  const bind = () => {
    bindOne('.js-auto-btn', el => window.poolToggleControl(el.dataset.key, el.dataset.current === '1'));
    bindOne('.js-device-btn', el => window.poolToggleState(el.dataset.key || '', el.dataset.current === '1'));
    bindOne('.js-standby-btn', el => window.poolToggleStandby(el.dataset.current === '1'));
    bindOne('.js-manual-dose-btn', el => window.poolPhManualDose(Number(el.dataset.sec || 30)));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
</script></body></html>`;
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
    const phClass = badgeClass(data.ph, 7.1, 7.25);
    const orpClass = badgeClass(data.orp, Number(data.orpOnThreshold || 725), Number(data.orpOffThreshold || 750));
    const metricTextClass = cls => cls === 'good' ? 'metric-good' : (cls === 'warn' || cls === 'bad' ? 'metric-bad' : '');
    const autoBtn = (label, key, active) => `
      <button class="ps-action-btn js-auto-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}">
        <span class="ps-action-name">${esc(label)}</span>
        <span class="ps-action-state">${active ? 'AKTIV' : 'AUS'}</span>
      </button>`;
    const deviceBtn = (label, key, active) => `
      <button class="ps-action-btn js-device-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}">
        <span class="ps-action-name">${esc(label)}</span>
        <span class="ps-action-state">${active ? 'EIN' : 'AUS'}</span>
      </button>`;
    const decisionValue = v => `<div class="ps-v ps-wrap">${esc(v)}</div>`;
    const trendClass = trend => trend === '↑' ? 'up' : (trend === '↓' ? 'down' : 'flat');
    const metricValue = (value, trend = '→', stateCls = '') => `<span class="ps-mmain ${stateCls}">${esc(value)}</span><span class="ps-trend ${trendClass(trend)} ${stateCls}" style="margin-left:10px;font-weight:900;font-size:18px;">${esc(trend)}</span>`;
    const batteryPct = Math.max(0, Math.min(100, parseNum(data.battery)));
    const batteryBar = `<div class="ps-bbar"><div class="ps-bfill" style="width:${batteryPct}%"></div></div>`;
    return `
<!-- widget-render:${esc(data.updated)} -->
<style>
.ps-root,*{box-sizing:border-box}
.ps-root{width:100%;max-width:1000px;height:730px;max-height:730px;overflow:hidden;padding:8px;margin:0 auto;color:#0f172a;font-family:Arial,Helvetica,sans-serif;background:linear-gradient(180deg,#0b1220 0%,#0f172a 100%)}
.ps-grid{display:grid;grid-template-columns:278px 330px 368px;gap:8px;width:100%;height:714px;overflow:hidden}
.ps-card{display:flex;flex-direction:column;min-width:0;overflow:hidden;background:linear-gradient(180deg,#f8fbff 0%,#eef4fb 100%);border:1px solid rgba(15,23,42,.08);border-radius:18px;padding:10px;box-shadow:0 14px 28px rgba(0,0,0,.18)}
.ps-hero{background:radial-gradient(circle at top right, rgba(85,200,255,.22), transparent 28%),linear-gradient(180deg,#1b3763 0%,#102342 100%);color:#fff;border-color:rgba(255,255,255,.1)}
.ps-header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.ps-title{font-size:16px;font-weight:800;color:inherit}.ps-ver{font-size:9px;font-weight:800;color:#b9d7ff;margin-left:6px}.ps-sub{font-size:11px;color:#d4deec;text-align:right;flex:0 0 auto}.ps-mode{display:inline-flex;align-items:center;justify-content:center;padding:3px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:linear-gradient(180deg,#334f84,#1b3158);font-weight:800;font-size:11px;color:#fff;cursor:pointer}
.ps-tempRow{display:flex;align-items:flex-end;gap:8px;margin:10px 0 10px}.ps-temp{font-size:70px;font-weight:900;line-height:.9;color:inherit}.ps-unit{font-size:20px;color:#d7e5f5;padding-bottom:8px}
.ps-scale{margin:2px 0 10px}.ps-track{position:relative;height:7px;border-radius:999px;background:linear-gradient(90deg,#46b3ff 0%, #58d27a 55%, #f5c04f 78%, #ff7f6f 100%)}.ps-target{position:absolute;top:50%;left:${Math.max(0, Math.min(100, ((parseNum(data.targetTemp)-15)/(32-15))*100 || 0))}%;width:3px;height:14px;border-radius:999px;background:#fff;border:1px solid rgba(17,48,91,.8);transform:translate(-50%,-50%)}.ps-dot{position:absolute;top:50%;left:${Math.max(0, Math.min(100, ((parseNum(data.poolTemp)-15)/(32-15))*100 || 0))}%;width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid #314a72;transform:translate(-50%,-50%)}.ps-scale-labels{display:flex;justify-content:space-between;margin-top:3px;font-size:9px;color:#e3edf9}.ps-target-label{position:relative;height:12px;font-size:10px;color:#e3edf9}.ps-target-label span{position:absolute;left:${Math.max(0, Math.min(100, ((parseNum(data.targetTemp)-15)/(32-15))*100 || 0))}%;transform:translateX(-50%)}
.ps-metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:auto}.ps-metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:8px;min-height:74px}.ps-k{font-size:12px;color:inherit;opacity:.88;margin-bottom:6px;font-weight:700}.ps-v{font-size:22px;font-weight:800;line-height:1.15;color:#0f172a}.ps-v.ps-wrap{font-size:13px;font-weight:700;line-height:1.2;word-break:break-word;overflow-wrap:anywhere;white-space:normal}.ps-s{font-size:11px;color:#e3edf9;margin-top:6px}.ps-hero .ps-v{color:#fff}.ps-chip{display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;border-radius:999px;font-size:9px;font-weight:800;margin-top:6px}.ps-chip.good{background:#dcfce7;color:#166534}.ps-chip.warn{background:#fef3c7;color:#92400e}.ps-chip.bad{background:#fee2e2;color:#991b1b}.ps-chip.neutral{background:#e2e8f0;color:#334155}
.ps-block-title{font-size:16px;font-weight:800;color:#0f172a;margin-bottom:8px}.ps-list{display:grid;gap:6px}.ps-row{display:grid;grid-template-columns:minmax(88px,116px) minmax(0,1fr);gap:8px;align-items:start;background:#ffffff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:8px}.ps-actions-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}.ps-action-btn{appearance:none;border:none;cursor:pointer;text-align:left;padding:10px 12px;border-radius:14px;min-height:58px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;gap:4px}.ps-action-btn:disabled{opacity:.5;cursor:default}.ps-action-name{font-size:14px;font-weight:800}.ps-action-state{font-size:12px;font-weight:800}.ps-action-btn.is-on .ps-action-name,.ps-action-btn.is-on .ps-action-state{color:#67dd7c}.ps-action-btn.is-off .ps-action-name,.ps-action-btn.is-off .ps-action-state{color:#ff8d7b}.ps-statuswrap{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
@media (max-width: 1050px){.ps-grid{grid-template-columns:1fr}}
</style>
<div class="ps-root"><div class="ps-grid">
  <div class="ps-card ps-hero">
    <div class="ps-header">
      <div><div class="ps-title">Pool Manager <span class="ps-ver">${esc(data.adapterVersion)}</span></div></div>
      <div class="ps-sub"><button class="ps-mode js-standby-btn" data-current="${data.standbyControl ? '1' : '0'}">${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}</button><br>Aktualisiert<br>${esc(data.updated)}</div>
    </div>
    <div class="ps-tempRow"><div class="ps-temp">${esc(data.poolTemp)}</div><div class="ps-unit">°C</div></div>
    <div class="ps-scale"><div class="ps-track"><div class="ps-target"></div><div class="ps-dot"></div></div><div class="ps-target-label"><span>Soll ${esc(data.targetTemp)}°C</span></div><div class="ps-scale-labels"><span>15 °C</span><span>32 °C</span></div></div>
    <div class="ps-metrics">
      <div class="ps-metric"><div class="ps-k">pH</div><div class="ps-v">${metricValue(data.ph, data.phTrend, ((data.phBadge && data.phBadge.cls) === 'ok' ? 'ok' : ((((data.phBadge && data.phBadge.cls) === 'warn') || ((data.phBadge && data.phBadge.cls) === 'bad')) ? 'bad' : '')))}</div><div class="ps-s">Soll ${esc(data.phSet)}</div><div class="ps-chip ${phClass}">${phClass === 'good' ? 'OK' : phClass === 'warn' ? 'Niedrig' : 'Hoch'}</div></div>
      <div class="ps-metric"><div class="ps-k">ORP</div><div class="ps-v">${metricValue(data.orp, data.orpTrend, ((data.orpBadge && data.orpBadge.cls) === 'ok' ? 'ok' : ((((data.orpBadge && data.orpBadge.cls) === 'warn') || ((data.orpBadge && data.orpBadge.cls) === 'bad')) ? 'bad' : '')))}</div><div class="ps-s">Soll ${esc(data.orpSet)}</div><div class="ps-chip ${orpClass}">${orpClass === 'good' ? 'OK' : orpClass === 'warn' ? 'Niedrig' : 'Hoch'}</div></div>
      <div class="ps-metric"><div class="ps-k">Außen</div><div class="ps-v">${metricValue(`${data.outsideTemp}°C`, data.outsideTempTrend, false)}</div></div>
      <div class="ps-metric"><div class="ps-k">Solltemp</div><div class="ps-v">${esc(data.targetTemp)}°C</div></div>
    </div>
  </div>
  <div class="ps-card">
    <div class="ps-block-title">Automatik</div>
    <div class="ps-actions-grid">
      ${autoBtn('Umwälzpumpe','circulation',!!data.autoCirculationControl)}
      ${autoBtn('Chlor','chlor',!!data.autoChlorControl)}
      ${autoBtn('pH','ph',!!data.autoPhControl)}
      ${autoBtn('Wärmepumpe','heatpump',!!data.autoHeatpumpControl)}
    </div>
    <div class="ps-block-title">Energie & Steuerung</div>
    <div class="ps-list">
      <div class="ps-row"><div class="ps-k">PV-Leistung</div><div class="ps-v">${esc(data.pv)} W</div></div>
      <div class="ps-row"><div class="ps-k">Netzeinspeisung</div><div class="ps-v">${esc(data.feedIn)} W</div></div>
      <div class="ps-row"><div class="ps-k">Netzbezug</div><div class="ps-v">${esc(data.gridSupply)} W</div></div>
      <div class="ps-row"><div class="ps-k">Batterie SoC</div><div class="ps-v">${esc(data.battery)} %</div></div>
      <div class="ps-row"><div class="ps-k">WP Freigabe</div>${decisionValue(data.heatDecision)}</div>
      <div class="ps-row"><div class="ps-k">Chlor Freigabe</div>${decisionValue(data.chlorDecision)}</div>
      <div class="ps-row"><div class="ps-k">Zeitplan</div>${decisionValue(data.pumpDecision)}</div>
      <div class="ps-row"><div class="ps-k">pH Prüfung</div>${decisionValue(data.phDecision)}</div>
    </div>
  </div>
  <div class="ps-card">
    <div class="ps-block-title">Aktoren & Status</div>
    <div class="ps-statuswrap">
      ${deviceBtn('Umwälzpumpe','circulation',!!data.pumpOn)}
      ${deviceBtn('Chlorinator','chlorinator',!!data.chlorOn)}
      ${deviceBtn('pH-Dosierpumpe','phPump',!!data.phPumpOn)}
      ${deviceBtn('Wärmepumpe','heatpump',!!data.heatpumpOn)}
    </div>
    <div class="ps-list">
      <div class="ps-row"><div class="ps-k">Zeitplan</div><div class="ps-v">${data.pumpScheduleActive ? 'AKTIV' : 'INAKTIV'}</div></div>
      <div class="ps-row"><div class="ps-k">PV Schwelle</div><div class="ps-v">${esc(data.threshold)} W</div></div>
      <div class="ps-row"><div class="ps-k">ORP Grenzen</div><div class="ps-v">${esc(data.orpOnThreshold)} / ${esc(data.orpOffThreshold)}</div></div>
      <div class="ps-row"><div class="ps-k">pH Tag</div><div class="ps-v">${esc(data.phDailyCount)}</div></div>
      <div class="ps-row"><div class="ps-k">Pumpe ml/min</div><div class="ps-v">${esc(data.phFlowMlMin)}</div></div>
      <div class="ps-row"><div class="ps-k">ml je 0,1 / 10m³</div><div class="ps-v">${esc(data.phMlPer01Per10)}</div></div>
      <div class="ps-row"><div class="ps-k">Poolvolumen</div><div class="ps-v">${esc(data.volume)} m³</div></div>
      <div class="ps-row"><div class="ps-k">Granulat manuell</div><div class="ps-v">${esc(data.manualGranulateText)}</div></div>
    </div>
  </div>
</div></div>
<script>
(function(){
  window.poolSetState = async function(id,val){
    try{ if(window.vis&&window.vis.conn&&typeof window.vis.conn.setState==='function'){ window.vis.conn.setState(id,val); return true; } }catch(e){}
    try{ if(window.parent&&window.parent.vis&&window.parent.vis.conn&&typeof window.parent.vis.conn.setState==='function'){ window.parent.vis.conn.setState(id,val); return true; } }catch(e){}
    try{ if(window.top&&window.top.vis&&window.top.vis.conn&&typeof window.top.vis.conn.setState==='function'){ window.top.vis.conn.setState(id,val); return true; } }catch(e){}
    return false;
  };
  window.poolToggleControl = async function(key,current){ const ns=${JSON.stringify(data.namespace)}; const ok=await window.poolSetState(ns+'.control.auto.'+key, !current); if(!ok) alert('VIS setState nicht verfügbar'); };
  window.poolToggleStandby = async function(current){ const ns=${JSON.stringify(data.namespace)}; const ok=await window.poolSetState(ns+'.control.standby', !current); if(!ok) alert('VIS setState nicht verfügbar'); };
  window.poolToggleState = async function(key,current){
    const ns=${JSON.stringify(data.namespace)};
    let ctrl='';
    if(key==='circulation') ctrl='.control.device.circulation';
    else if(key==='chlorinator') ctrl='.control.device.chlorinator';
    else if(key==='phPump') ctrl='.control.device.phPump';
    else if(key==='heatpump') ctrl='.control.device.heatpump';
    if(!ctrl){ alert('Kein Control-Key hinterlegt'); return; }
    const ok=await window.poolSetState(ns+ctrl, !current);
    if(!ok) alert('VIS setState nicht verfügbar');
  };
})();
</script>`;
  }

  buildPhoneWidget(data) {
    const poolTempNum = parseNum(data.poolTemp);
    const tempScaleMin = 15;
    const tempScaleMax = 32;
    const tempPct = Number.isFinite(poolTempNum) ? Math.max(0, Math.min(100, ((poolTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100)) : 0;
    const targetTempNum = parseNum(data.targetTemp);
    const targetPct = Number.isFinite(targetTempNum) ? Math.max(0, Math.min(100, ((targetTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100)) : 0;
    const autoBtn = (label, key, active) => `<button class="ps-btn js-auto-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="ps-btn-name">${esc(label)}</span><span class="ps-btn-state">${active ? 'AKTIV' : 'AUS'}</span></button>`;
    const deviceBtn = (label, key, active) => `<button class="ps-btn js-device-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="ps-btn-name">${esc(label)}</span><span class="ps-btn-state">${active ? 'EIN' : 'AUS'}</span></button>`;
    const quick = (l, v, trend = '', barHtml = '') => `<div class="ps-q"><div class="ps-ql">${esc(l)}</div><div class="ps-qvr"><div class="ps-qv">${esc(v)}</div>${trend ? `<div class="ps-qtrend ${trendClass(trend)}">${esc(trend)}</div>` : ''}</div>${barHtml || ''}</div>`;
    const trendClass = trend => trend === '↑' ? 'up' : (trend === '↓' ? 'down' : 'flat');
    const metricValue = (value, trend = '→', stateCls = '') => `<span class="ps-mmain ${stateCls}">${esc(value)}</span><span class="ps-trend ${trendClass(trend)} ${stateCls}" style="margin-left:10px;font-weight:900;font-size:18px;">${esc(trend)}</span>`;
    const batteryPct = Math.max(0, Math.min(100, parseNum(data.battery)));
    const batteryBar = `<div class="ps-bbar"><div class="ps-bfill" style="width:${batteryPct}%"></div></div>`;
    return `<!-- phone-render:${esc(data.updated)} -->
<style>
.ps-wrap{width:100%;max-width:510px;height:1090px;max-height:1090px;overflow:hidden;margin:0 auto;display:grid;gap:4px;padding:4px;background:radial-gradient(circle at top left, rgba(89,188,255,.18), transparent 28%),linear-gradient(180deg,#10203a,#08111f);font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif}
.ps-card{background:linear-gradient(180deg,#ffffff 0%,#eef5ff 100%);border:1px solid rgba(15,23,42,.08);border-radius:15px;padding:6px;box-shadow:0 8px 18px rgba(0,0,0,.15)}
.ps-hero{background:radial-gradient(circle at top right, rgba(85,200,255,.26), transparent 26%),linear-gradient(180deg,#1b3763 0%,#0f2343 100%);color:#fff;border-color:rgba(255,255,255,.10)}
.ps-header{display:flex;justify-content:space-between;gap:6px;align-items:flex-start}.ps-title{font-size:15px;font-weight:900}.ps-ver{font-size:9px;font-weight:800;color:#b9d7ff;margin-left:6px}.ps-sub{font-size:9px;color:#d2dded;text-align:right}.ps-mode{display:inline-flex;align-items:center;justify-content:center;padding:3px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:linear-gradient(180deg,#334f84,#1b3158);font-weight:800;font-size:10px;color:#fff;cursor:pointer}
.ps-tempRow{display:flex;align-items:flex-end;gap:5px;margin:4px 0 4px}.ps-temp{font-size:42px;font-weight:900;line-height:.9}.ps-unit{font-size:16px;padding-bottom:4px;color:#d5e5f6}
.ps-scale{margin:2px 0 5px}.ps-track{position:relative;height:7px;border-radius:999px;background:linear-gradient(90deg,#46b3ff 0%, #58d27a 55%, #f5c04f 78%, #ff7f6f 100%)}.ps-target{position:absolute;top:50%;left:${targetPct}%;width:3px;height:14px;border-radius:999px;background:#fff;border:1px solid rgba(17,48,91,.8);transform:translate(-50%,-50%)}.ps-dot{position:absolute;top:50%;left:${tempPct}%;width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid #314a72;transform:translate(-50%,-50%)}.ps-scale-labels{display:flex;justify-content:space-between;margin-top:3px;font-size:9px;color:#e3edf9}.ps-target-label{position:relative;height:12px;font-size:9px;color:#d2dded}.ps-target-label span{position:absolute;left:${targetPct}%;transform:translateX(-50%)}
.ps-metrics,.ps-auto,.ps-statusGrid,.ps-quickGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}.ps-phGrid{grid-template-columns:repeat(3,minmax(0,1fr))}
.ps-metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:6px}.ps-ml{font-size:10px;color:#d9e5f5}.ps-mv{font-size:13px;font-weight:900;color:#fff;display:flex;align-items:center}.ps-ms{display:none}.ps-mmain.ok{color:#67dd7c}.ps-mmain.bad{color:#ff7a6a}.ps-trend{font-size:18px;font-weight:900;color:#c9d7ee;line-height:1;display:inline-flex;min-width:18px;justify-content:center;margin-left:10px}.ps-trend.up{color:#ffb36b}.ps-trend.down{color:#7dd3fc}.ps-trend.flat{color:#c9d7ee}.ps-trend.ok{color:#67dd7c}.ps-trend.bad{color:#ff7a6a}.ps-section{font-size:12px;font-weight:900;color:#0f172a;margin-bottom:3px}
.ps-btn{appearance:none;border:none;cursor:pointer;text-align:left;padding:7px 9px;border-radius:13px;min-height:44px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;gap:3px}.ps-btn:disabled{opacity:.5;cursor:default}.ps-btn-name{font-size:12px;font-weight:800}.ps-btn-state{font-size:9px;font-weight:800}.ps-btn.is-on .ps-btn-name,.ps-btn.is-on .ps-btn-state{color:#67dd7c}.ps-btn.is-off .ps-btn-name,.ps-btn.is-off .ps-btn-state{color:#ff8d7b}
.ps-q{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:6px}.ps-ql{font-size:9px;color:#64748b;font-weight:700;margin-bottom:3px}.ps-qv{font-size:12px;font-weight:900;color:#0f172a;line-height:1.08}
.manual-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:7px 9px;border-radius:999px;min-height:44px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}.manual-btn span{font-size:13px}.manual-btn small{font-size:10px;color:#dbeafe}
</style>
<div class="ps-wrap">
  <div class="ps-card ps-hero">
    <div class="ps-header"><div class="ps-title">Pool Manager <span class="ps-ver">${esc(data.adapterVersion)}</span></div><div class="ps-sub"><button class="ps-mode js-standby-btn" data-current="${data.standbyControl ? '1' : '0'}">${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}</button><br>Aktualisiert<br>${esc(data.updated)}</div></div>
    <div class="ps-tempRow"><div class="ps-temp">${esc(data.poolTemp)}</div><div class="ps-unit">°C</div></div>
    <div class="ps-scale"><div class="ps-track"><div class="ps-target"></div><div class="ps-dot"></div></div><div class="ps-target-label"><span>Soll ${esc(data.targetTemp)}°C</span></div><div class="ps-scale-labels"><span>15 °C</span><span>32 °C</span></div></div>
    <div class="ps-metrics">
      <div class="ps-metric"><div class="ps-ml">pH</div><div class="ps-mv">${metricValue(data.ph, data.phTrend, ((data.phBadge && data.phBadge.cls) === 'ok' ? 'ok' : ((((data.phBadge && data.phBadge.cls) === 'warn') || ((data.phBadge && data.phBadge.cls) === 'bad')) ? 'bad' : '')))}</div></div>
      <div class="ps-metric"><div class="ps-ml">ORP</div><div class="ps-mv">${metricValue(data.orp, data.orpTrend, ((data.orpBadge && data.orpBadge.cls) === 'ok' ? 'ok' : ((((data.orpBadge && data.orpBadge.cls) === 'warn') || ((data.orpBadge && data.orpBadge.cls) === 'bad')) ? 'bad' : '')))}</div></div>
      <div class="ps-metric"><div class="ps-ml">Außen</div><div class="ps-mv">${metricValue(`${data.outsideTemp}°C`, data.outsideTempTrend, false)}</div></div>
      <div class="ps-metric"><div class="ps-ml">Soll</div><div class="ps-mv">${esc(data.targetTemp)}°C</div></div>
    </div>
  </div>
  <div class="ps-card"><div class="ps-section">Automatik</div><div class="ps-auto">
    ${autoBtn('Umwälzpumpe','circulation',!!data.autoCirculationControl)}
    ${autoBtn('Chlor','chlor',!!data.autoChlorControl)}
    ${autoBtn('pH','ph',!!data.autoPhControl)}
    ${autoBtn('Wärmepumpe','heatpump',!!data.autoHeatpumpControl)}
  </div></div>
  <div class="ps-card"><div class="ps-section">Aktoren & Status</div><div class="ps-statusGrid">
    ${deviceBtn('Umwälzpumpe','circulation',!!data.pumpOn)}
    ${deviceBtn('Chlorinator','chlorinator',!!data.chlorOn)}
    ${deviceBtn('pH-Dosierpumpe','phPump',!!data.phPumpOn)}
    ${deviceBtn('Wärmepumpe','heatpump',!!data.heatpumpOn)}
  </div></div>
  <div class="ps-card"><div class="ps-section">Energie & Steuerung</div><div class="ps-quickGrid">
    ${quick('PV-Leistung', `${data.pv} W`, data.pvTrend || '→')}
    ${quick('Einspeisung', `${data.feedIn} W`, data.feedInTrend || '→')}
    ${quick('Batterie', `${data.battery} %`, '', batteryBar)}
    ${quick('WP Freigabe', data.heatDecision)}
    ${quick('Chlor Freigabe', data.chlorDecision)}
    ${quick('pH Prüfung', data.phDecision)}
  </div></div>
  <div class="ps-card"><div class="ps-section">pH Info</div><div class="ps-quickGrid ps-phGrid">
    ${quick('Berechnet', `${data.phCalculatedDoseSec} s / ${data.phCalculatedDoseMl} ml`)}
    ${quick('Letzte Dosis', `${data.phLastDoseDurationSec} s / ${data.phLastDoseMl} ml`)}
    ${quick('Heute dosiert', `${data.phDailyCount}x`)}
    ${quick('Nächste Prüfung', data.phNextCheck)}
    ${quick('Granulat manuell', data.manualGranulateText)}
    <button class="manual-btn js-manual-dose-btn" data-sec="${Number(data.manualDoseButtonSec || 30) || 30}"><span>PH Manuell</span><small>${esc(data.manualDoseButtonSec || 30)} Sek.</small></button>
  </div></div>
</div>
<script>
(function(){
  window.poolSetState = async function(id,val){
    try{ if(window.vis&&window.vis.conn&&typeof window.vis.conn.setState==='function'){ window.vis.conn.setState(id,val); return true; } }catch(e){}
    try{ if(window.parent&&window.parent.vis&&window.parent.vis.conn&&typeof window.parent.vis.conn.setState==='function'){ window.parent.vis.conn.setState(id,val); return true; } }catch(e){}
    try{ if(window.top&&window.top.vis&&window.top.vis.conn&&typeof window.top.vis.conn.setState==='function'){ window.top.vis.conn.setState(id,val); return true; } }catch(e){}
    return false;
  };
  window.poolToggleControl = async function(key,current){ const ns=${JSON.stringify(data.namespace)}; const ok=await window.poolSetState(ns+'.control.auto.'+key, !current); if(!ok) alert('VIS setState nicht verfügbar'); };
  window.poolToggleStandby = async function(current){ const ns=${JSON.stringify(data.namespace)}; const ok=await window.poolSetState(ns+'.control.standby', !current); if(!ok) alert('VIS setState nicht verfügbar'); };
  window.poolToggleState = async function(key,current){
    const ns=${JSON.stringify(data.namespace)};
    let ctrl='';
    if(key==='circulation') ctrl='.control.device.circulation';
    else if(key==='chlorinator') ctrl='.control.device.chlorinator';
    else if(key==='phPump') ctrl='.control.device.phPump';
    else if(key==='heatpump') ctrl='.control.device.heatpump';
    if(!ctrl){ alert('Kein Control-Key hinterlegt'); return; }
    const ok=await window.poolSetState(ns+ctrl, !current);
    if(!ok) alert('VIS setState nicht verfügbar');
  };
  window.poolPhManualDose = async function(sec){ const ns=${JSON.stringify(data.namespace)}; await window.poolSetState(ns + '.control.ph.manualDoseSec', Number(sec) || 30); const ok=await window.poolSetState(ns + '.control.ph.manualStart', true); if(!ok) alert('VIS setState nicht verfügbar'); };
})();
</script>`;
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
    const wallboxChargingStatusRaw = await this.getText(this.config.wallboxChargingStatusStateId, '--');
    const wallboxPlugStatusRaw = await this.getText(this.config.wallboxPlugStatusStateId, '--');
    const wallboxSocNum = await this.getNumber(this.config.wallboxSocStateId, NaN);
    const wallboxTargetSocNum = await this.getNumber(this.config.wallboxTargetSocStateId, NaN);
    const wallboxTimeFullNum = await this.getNumber(this.config.wallboxTimeToFullStateId, NaN);
    const wallboxRangeKmNum = await this.getNumber(this.config.wallboxRangeKmStateId, NaN);
    const wallboxPowerKwNum = await this.getNumber(this.config.wallboxPowerKwStateId, NaN);
    const pumpStateSnap = await this.getStateSnapshot(this.config.circulationPumpSocketStateId);
    const chlorStateSnap = await this.getStateSnapshot(this.config.chlorinatorSocketStateId);
    const phPumpStateSnap = await this.getStateSnapshot(this.config.phPumpSocketStateId);
    const heatpumpStateSnap = await this.getStateSnapshot(this.config.heatpumpPowerStateId);
    const pumpSync = this.getDeviceSyncInfo(pumpStateSnap, 180);
    const chlorSync = this.getDeviceSyncInfo(chlorStateSnap, 180);
    const phPumpSync = this.getDeviceSyncInfo(phPumpStateSnap, 180);
    const heatpumpSync = this.getDeviceSyncInfo(heatpumpStateSnap, 180);
    const wallboxChargingRawText = String(wallboxChargingStatusRaw || '').trim().toLowerCase();
    const wallboxPlugRawText = String(wallboxPlugStatusRaw || '').trim().toLowerCase();
    const wallboxIsConnected = ['connected', 'verbunden'].includes(wallboxPlugRawText);
    const wallboxPowerForStatus = (wallboxIsConnected && Number.isFinite(wallboxPowerKwNum) && wallboxPowerKwNum >= 0.3) ? wallboxPowerKwNum : 0;
    const wallboxCharging = ['charging','laden','lädt','charge_state_charging_hv_battery'].includes(wallboxChargingRawText) || wallboxPowerForStatus >= 0.3;
    const wallboxChargingStatus = wallboxIsConnected ? (wallboxCharging ? 'LÄDT' : (wallboxChargingRawText === 'idle' ? 'BEREIT' : String(wallboxChargingStatusRaw || '--'))) : 'GETRENNT';
    const wallboxPlugStatus = wallboxIsConnected ? 'Verbunden' : (wallboxPlugRawText === 'disconnected' ? 'Getrennt' : String(wallboxPlugStatusRaw || '--'));
    const wallboxSoc = this.fmt(wallboxSocNum, 0, '--');
    const wallboxTargetSoc = this.fmt(wallboxTargetSocNum, 0, '--');
    const wallboxRangeKm = this.fmt(wallboxRangeKmNum, 0, '--');
    const wallboxPowerKw = this.fmt(wallboxPowerForStatus, 1, '--');
    const wallboxTimeToFull = wallboxCharging ? this.formatDurationHours(wallboxTimeFullNum, '--') : '--';
    const wallboxDatasetCreatedOn = '--';
    const wallboxTibberLastSeen = await this.getFormattedDateTimeFromState('vw-connect.0.WVGZZZE23TE055069.statustibber.rawData.status.lastSeen', '--');
    const targetTempNumFromState = this.config.heatpumpSetTempStateId
      ? await this.getNumber(this.config.heatpumpSetTempStateId, NaN)
      : NaN;
    const targetTemp = this.fmt(Number.isFinite(targetTempNumFromState) ? targetTempNumFromState : parseNum(this.config.heatpumpTargetTemp), 1, '24.0');
    const heatReason = await this.getText('poolsteuerung.0.status.heatpump.lastReason', '--');
    const autoCirculationState = await this.getControlBool('control.auto.circulation', this.config.enableCirculationControl !== false);
    const autoChlorState = await this.getControlBool('control.auto.chlor', this.config.enableChlorControl !== false);
    const autoPhState = await this.getControlBool('control.auto.ph', this.config.enablePhControl !== false);
    const autoHeatpumpState = await this.getControlBool('control.auto.heatpump', this.config.enableHeatpumpControl !== false);
    const autoCirculation = autoCirculationState ? 'AKTIV' : 'AUS';
    const autoChlor = autoChlorState ? 'AKTIV' : 'AUS';
    const autoPh = autoPhState ? 'AKTIV' : 'AUS';
    const autoHeatpump = autoHeatpumpState ? 'AKTIV' : 'AUS';
    const standbyMode = await this.getControlBool('control.standby', this.config.standbyModeEnabled === true);
    const modeActive = standbyMode ? 'standby' : 'normal';
    const standbyNext = standbyMode ? this.getNextStandbyRun(new Date()) : null;
    const pumpDecision = await this.getText('poolsteuerung.0.status.debug.lastPumpDecision', standbyMode ? 'Standby aktiv' : '--');
    const phDecision = await this.getText('poolsteuerung.0.status.debug.lastPhDecision', '--');
    const phDailyCount = await this.getText('poolsteuerung.0.status.phDose.dailyCount', '0');
    const phLastDoseDurationSec = await this.getText('poolsteuerung.0.status.phDose.lastDoseDurationSec', '0');
    const phCalculatedDoseSec = await this.getText('poolsteuerung.0.status.phDose.calculatedDoseSec', '0');
    const phLastDoseTsRaw = await this.getNumber('poolsteuerung.0.status.phDose.lastDoseTs', 0);
    const phLastDoseAt = phLastDoseTsRaw ? new Date(phLastDoseTsRaw).toLocaleString('de-DE') : '-';
    const phLastStartInfo = await this.getText('poolsteuerung.0.status.debug.lastPhStartInfo', '');
    const phInfoText = phLastStartInfo || phDecision || '--';
    const nextPhCheck = standbyMode ? null : this.getNextPhCheck(new Date());
    const phNextCheck = nextPhCheck ? nextPhCheck.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
    const phFlowMlMinNum = parseNum(this.config.phPumpFlowMlPerMin);
    const phFlowMlMin = this.fmt(phFlowMlMinNum, 0, '--');
    const phCalculatedDoseMl = Number.isFinite(phFlowMlMinNum) ? this.fmt((parseNum(phCalculatedDoseSec) || 0) * phFlowMlMinNum / 60, 0, '0') : '--';
    const phLastDoseMl = Number.isFinite(phFlowMlMinNum) ? this.fmt((parseNum(phLastDoseDurationSec) || 0) * phFlowMlMinNum / 60, 0, '0') : '--';
    const phCurrentNum = parseNum(ph);
    const phTargetNum = parseNum(this.config.phSetpoint);
    const manualGranulateGNum = Number.isFinite(phCurrentNum) && Number.isFinite(phTargetNum) && phCurrentNum > phTargetNum
      ? Math.round(((phCurrentNum - phTargetNum) / 0.1) * (this.calcVolume() / 10) * 100)
      : 0;
    const manualGranulateG = this.fmt(manualGranulateGNum, 0, '0');
    const manualGranulateText = manualGranulateGNum > 0 ? `${manualGranulateG} g` : 'nicht nötig';
    const infoLower = String(phInfoText || '').toLowerCase();
    const phInfoLevel = infoLower.includes('block') || infoLower.includes('fehler') || infoLower.includes('ungültig')
      ? 'warn'
      : infoLower.includes('keine dosierung') || infoLower.includes('freigabe aus') || infoLower.includes('standby')
        ? 'ok'
        : 'info';
    const phMlPer01Per10 = this.fmt(parseNum(this.config.phDoseMlPer01Per10m3), 0, '--');
    const volume = this.fmt(this.calcVolume(), 2, '--');

    const circulationEnabled = !standbyMode && await this.getControlBool('control.auto.circulation', this.config.enableCirculationControl !== false);
    const phEnabledMaster = !standbyMode && await this.getControlBool('control.auto.ph', this.config.enablePhControl !== false);
    const heatEnabledMaster = !standbyMode && await this.getControlBool('control.auto.heatpump', this.config.enableHeatpumpControl !== false);
    const chlorEnabledMaster = !standbyMode && await this.getControlBool('control.auto.chlor', this.config.enableChlorControl !== false);

    const pumpOn = await this.getBool(this.config.circulationPumpSocketStateId);
    const pumpScheduleActive = standbyMode ? this.isStandbyPumpActive(new Date()) : (typeof this.isPumpScheduleActive === 'function' ? this.isPumpScheduleActive(new Date()) : false);
    const chlorOnRaw = await this.getBool(this.config.chlorinatorSocketStateId);
    let phPumpOn = await this.getBool(this.config.phPumpSocketStateId);
    const threshold = parseNum(this.config.heatEnableFeedInThresholdW || 1000);
    if (!phEnabledMaster && !pumpOn && phPumpOn) {
      try { await this.setSwitchStateCompat(this.config.phPumpSocketStateId, false); } catch (e) { this.log.warn('pH-Pumpe konnte nicht wegen Pumpenstop ausgeschaltet werden: ' + e); }
      phPumpOn = false;
    }

    const orpOnThreshold = parseNum(this.config.orpOnThreshold || 725);
    const orpOffThreshold = parseNum(this.config.orpOffThreshold || 750);

    let chlorDesired = chlorOnRaw;
    let chlorDecision = '';
    if (standbyMode) {
      chlorDesired = false;
      chlorDecision = 'Standby aktiv';
    } else if (!chlorEnabledMaster) {
      chlorDesired = chlorOnRaw;
      chlorDecision = `Steuerung deaktiviert${chlorOnRaw ? ' · manuell EIN' : ' · manuell AUS'}`;
    }
    const orpNum = parseNum(orp);
    const chlorDelaySec = Math.max(0, parseNum(this.config.chlorPumpStartDelaySec || 0));
    const pumpOnForSec = this.getPumpOnForSec();

    if (!chlorEnabledMaster) {
      if (!pumpOn && chlorOnRaw) {
        chlorDesired = false;
        chlorDecision = 'Manuell blockiert: Pumpe AUS';
      } else {
        chlorDecision = chlorOnRaw ? 'Manuell EIN (Auto AUS)' : 'Steuerung deaktiviert · manuell AUS';
      }
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
        await (chlorDesired ? this.forceSwitchOnCompat(this.config.chlorinatorSocketStateId) : this.forceSwitchOffCompat(this.config.chlorinatorSocketStateId));
      } catch (e) {
        this.log.warn('Chlorinator konnte nicht gesetzt werden: ' + e);
      }
    }

    const chlorOn = chlorEnabledMaster ? (pumpOn ? chlorDesired : false) : chlorOnRaw;
    let heatDecision = '';
    const circulationHeartbeatOkDisplay = await this.getHeartbeatOk('status.checks.circulationPump');
    const heatpumpOnRaw = await this.getBool(this.config.heatpumpPowerStateId);
    const heatLock = this.getHeatpumpLockState();
    if (heatLock.state === null) {
      heatLock.state = heatpumpOnRaw;
      if (heatpumpOnRaw) heatLock.lastOnTs = Date.now();
      else heatLock.lastOffTs = Date.now();
    }

    let heatDesired = heatpumpOnRaw;
    let allowHeatpumpWrite = true;

    if (!heatEnabledMaster) {
      allowHeatpumpWrite = false;
      if (!pumpOn && heatpumpOnRaw) {
        heatDesired = false;
        heatDecision = 'Sicherheits-AUS: Umwälzpumpe AUS';
        allowHeatpumpWrite = true;
      } else if (standbyMode && heatpumpOnRaw) {
        heatDesired = false;
        heatDecision = 'Sicherheits-AUS: Standby aktiv';
        allowHeatpumpWrite = true;
      } else {
        heatDesired = heatpumpOnRaw;
        heatDecision = heatpumpOnRaw ? 'Manuell EIN (Auto AUS)' : 'Steuerung deaktiviert · manuell AUS';
      }
    } else if (!circulationHeartbeatOkDisplay && !pumpOn) {
      heatDesired = false;
      heatDecision = 'Umwälzpumpe nicht erreichbar';
    } else {
      const hyst = this.applyHeatpumpHysteresis(true, `PV OK (${feedIn}W >= ${threshold}W) · Temperatur regelt WP selbst`, poolTemp, targetTemp, feedIn, threshold);
      heatDesired = hyst.desiredOn;
      heatDecision = hyst.reason;
    }

    if (heatEnabledMaster && this.isControlTransitionActive() && heatLock.state !== null) {
      heatDesired = heatLock.state;
      heatDecision = `Schaltsperre aktiv / Anti-Pendeln`;
    }

    if (heatEnabledMaster && pumpOn && Number.isFinite(feedIn) && feedIn >= parseNum(this.config.heatpumpPvOffThresholdW || 800) && heatLock.state === true) {
      heatDesired = true;
      if (!this.isControlTransitionActive()) {
        heatDecision = `PV halten / Anti-Pendeln (${feedIn}W >= ${parseNum(this.config.heatpumpPvOffThresholdW || 800)}W)`;
      }
    }

    if (allowHeatpumpWrite && this.config.heatpumpPowerStateId && heatDesired !== heatpumpOnRaw) {
      try {
        await (heatDesired ? this.forceSwitchOnCompat(this.config.heatpumpPowerStateId) : this.forceSwitchOffCompat(this.config.heatpumpPowerStateId));
      } catch (e) {
        this.log.warn('Wärmepumpe konnte nicht gesetzt werden: ' + e);
      }
    }

    if (allowHeatpumpWrite && heatDesired !== heatLock.state) {
      heatLock.state = heatDesired;
      if (heatDesired) heatLock.lastOnTs = Date.now();
      else heatLock.lastOffTs = Date.now();
    }

    const heatpumpOn = allowHeatpumpWrite ? heatDesired : heatpumpOnRaw;

    const historyTrends = await this.getHistoryTrends();
    const phTrend = historyTrends.phTrend || '→';
    const orpTrend = historyTrends.orpTrend || '→';
    const poolTempTrend = historyTrends.poolTempTrend || '→';
    const outsideTempTrend = historyTrends.outsideTempTrend || '→';
    const pvTrend = historyTrends.pvTrend || '→';
    const feedInTrend = historyTrends.feedInTrend || '→';

    const phNumStable = parseNum(ph);
    const orpNumStable = parseNum(orp);
    const phInRange = Number.isFinite(phNumStable) && phNumStable >= 7.1 && phNumStable <= 7.25;
    const orpInRange = Number.isFinite(orpNumStable) && orpNumStable >= parseNum(orpOnThreshold) && orpNumStable <= parseNum(orpOffThreshold);

    const heatpumpAuxIds = this.getDerivedHeatpumpAuxStateIds();
    const heatpumpFanPercent = await this.getText(heatpumpAuxIds.speedId, '--');
    const heatpumpMode = this.formatHeatpumpMode(await this.getText(heatpumpAuxIds.modeId, '--'));

    const stableData = {
      ph, orp, poolTemp, outsideTemp, pv, feedIn, gridSupply, battery, targetTemp, heatReason, volume, modeActive,
      autoCirculation, autoChlor, autoPh, autoHeatpump,
      phSet: this.fmt(parseNum(this.config.phSetpoint), 2, '--'),
      phTrend,
      orpTrend,
      poolTempTrend,
      outsideTempTrend,
      pvTrend,
      feedInTrend,
      phInRange,
      orpInRange,
      phTimes: standbyMode ? '-' : (this.config.phCheckTimes || '-'),
      standbyNext: standbyNext ? `${standbyNext.toLocaleDateString('de-DE')}, ${String(standbyNext.getHours()).padStart(2,'0')}:${String(standbyNext.getMinutes()).padStart(2,'0')}` : '-',
      pumpDecision,
      phDecision,
      phDailyCount,
      phLastDoseDurationSec,
      phCalculatedDoseSec,
      phCalculatedDoseMl,
      phLastDoseAt,
      phLastDoseMl,
      manualGranulateG,
      manualGranulateText,
      phInfoText,
      phInfoLevel,
      phNextCheck,
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
      batteryRounded: Math.round(parseNum(battery)),
      wallboxCharging,
      wallboxChargingStatus,
      wallboxPlugStatus,
      wallboxSoc,
      wallboxTargetSoc,
      wallboxRangeKm,
      wallboxPowerKw,
      wallboxTimeToFull,
      namespace: this.namespace,
      standbyControl: standbyMode,
      autoCirculationControl: await this.getControlBool('control.auto.circulation', circulationEnabled),
      autoChlorControl: await this.getControlBool('control.auto.chlor', chlorEnabledMaster),
      autoPhControl: await this.getControlBool('control.auto.ph', phEnabledMaster),
      autoHeatpumpControl: await this.getControlBool('control.auto.heatpump', heatEnabledMaster),
      circulationPumpStateId: this.config.circulationPumpSocketStateId || '',
      chlorinatorStateId: this.config.chlorinatorSocketStateId || '',
      phPumpStateId: this.config.phPumpSocketStateId || '',
      heatpumpStateId: this.config.heatpumpPowerStateId || '',
      heatpumpSetTempStateId: this.config.heatpumpSetTempStateId || '',
      heatpumpFanPercent,
      heatpumpMode,
      pumpSyncCls: pumpSync.cls,
      pumpSyncLabel: pumpSync.label,
      chlorSyncCls: chlorSync.cls,
      chlorSyncLabel: chlorSync.label,
      phPumpSyncCls: phPumpSync.cls,
      phPumpSyncLabel: phPumpSync.label,
      heatpumpSyncCls: heatpumpSync.cls,
      heatpumpSyncLabel: heatpumpSync.label,
      phManualDoseSec: await this.getText('poolsteuerung.0.control.ph.manualDoseSec', String(Math.max(1, parseNum(this.config.phDoseDurationSec || 30)))),
      manualDoseButtonSec: Math.max(1, parseNum(await this.getText('poolsteuerung.0.control.ph.manualDoseSec', String(Math.max(1, parseNum(this.config.phDoseDurationSec || 30))))) || Math.max(1, parseNum(this.config.phDoseDurationSec || 30))),
      adapterVersion: 'v0.3.16hf38'
    };

    const now = Date.now();
    const signature = JSON.stringify(stableData);

    if (signature === this.lastRenderSignature && now - this.lastRenderAt < 300000) {
      return;
    }

    this.lastRenderSignature = signature;
    this.lastRenderAt = now;

    const renderStamp = new Date();
    const updatedText = `${renderStamp.toLocaleDateString('de-DE')}, ${String(renderStamp.getHours()).padStart(2,'0')}:${String(renderStamp.getMinutes()).padStart(2,'0')}`;
    const data = {
      updated: updatedText,
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
    if (tablet !== this.lastTabletHtml) {
      await this.setStateIfChanged('vis.htmlTablet', tablet, true);
      this.lastTabletHtml = tablet;
    }
    if (phone !== this.lastPhoneHtml) {
      await this.setStateIfChanged('vis.htmlPhone', phone, true);
      this.lastPhoneHtml = phone;
    }
    if (tabletWidget !== this.lastTabletWidget) {
      await this.setStateIfChanged('vis.widgetTablet', tabletWidget, true);
      this.lastTabletWidget = tabletWidget;
    }
    if (phoneWidget !== this.lastPhoneWidget) {
      await this.setStateIfChanged('vis.widgetPhone', phoneWidget, true);
      this.lastPhoneWidget = phoneWidget;
    }
    await this.ensureState('status.debug.lastVisUpdate', 'string', 'text', '', false);
    await this.setStateIfChanged('status.debug.lastVisUpdate', data.updated, true);
    await this.ensureState('status.debug.lastDecision', 'string', 'text', '', false);
    await this.setStateAsync('status.debug.lastDecision', `WP: ${data.heatpumpOn ? 'EIN' : 'AUS'} | ${data.heatDecision} || Chlor: ${data.chlorOn ? 'EIN' : 'AUS'} | ${data.chlorDecision}`, true);

  }

  queueRender() {
    if (this.renderQueued || this.isShuttingDown) return;
    this.renderQueued = true;
    const handle = this.trackTimeout(setTimeout(async () => {
      this.pendingTimeouts.delete(handle);
      this.renderQueued = false;
      if (this.isShuttingDown) return;
      try {
        await this.setStateIfChanged('control.device.circulation', await this.getBool(this.config.circulationPumpSocketStateId), true);
        await this.setStateIfChanged('control.device.chlorinator', await this.getBool(this.config.chlorinatorSocketStateId), true);
        await this.setStateIfChanged('control.device.phPump', await this.getBool(this.config.phPumpSocketStateId), true);
        await this.setStateIfChanged('control.device.heatpump', await this.getBool(this.config.heatpumpPowerStateId), true);
        await this.updateComputedStates();
        await this.syncControlStates();
        await this.syncDeviceControlStates();
        await this.renderVis();
      } catch (e) {
        if (!this.isDbClosedError(e)) this.log.warn('VIS Render Fehler: ' + (e && e.stack ? e.stack : e));
      }
    }, 1800));
  }

  queueDelayedRefresh(delayMs = 1800) {
    if (this.isShuttingDown) return;
    const handle = this.trackTimeout(setTimeout(async () => {
      this.pendingTimeouts.delete(handle);
      if (this.isShuttingDown) return;
      try {
        await this.updateComputedStates();
        if (typeof this.applyControlLogic === 'function') {
          await this.applyControlLogic();
        }
        await this.syncControlStates();
        await this.syncDeviceControlStates();
        this.lastRenderSignature = '';
        this.lastRenderAt = 0;
        await this.renderVis();
      } catch (e) {
        if (!this.isDbClosedError(e)) this.log.warn('VIS Delayed Refresh Fehler: ' + (e && e.stack ? e.stack : e));
      }
    }, delayMs));
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

  getHeatpumpLockState() {
    if (!this.heatpumpLock) {
      this.heatpumpLock = { state: null, lastOnTs: 0, lastOffTs: 0 };
    }
    return this.heatpumpLock;
  }

  applyHeatpumpHysteresis(desiredOn, reason, poolTemp, targetTemp, feedIn, threshold) {
    const lock = this.getHeatpumpLockState();
    const pvOnThreshold = parseNum(this.config.heatpumpPvOnThresholdW || parseNum(threshold) || 1000);
    const pvOffThreshold = parseNum(this.config.heatpumpPvOffThresholdW || 800);
    const minSwitchSec = Math.max(300, parseNum(this.config.heatpumpMinSwitchSec || 600) || 600);

    const feedNum = parseNum(feedIn);
    const currentState = lock.state;
    const nowTs = Date.now();

    let nextDesired = desiredOn;
    let nextReason = reason;

    if (Number.isFinite(feedNum)) {
      if (currentState === true) {
        if (feedNum < pvOffThreshold) {
          nextDesired = false;
          nextReason = `PV AUS-Hysterese (${feedNum}W < ${pvOffThreshold}W)`;
        } else {
          nextDesired = true;
          nextReason = `PV halten / Anti-Pendeln (${feedNum}W >= ${pvOffThreshold}W)`;
        }
      } else if (feedNum >= pvOnThreshold) {
        nextDesired = true;
        nextReason = `PV EIN-Hysterese (${feedNum}W >= ${pvOnThreshold}W)`;
      } else {
        nextDesired = false;
        nextReason = `PV zu gering (${feedNum}W < ${pvOnThreshold}W)`;
      }
    }

    if (currentState === true && nextDesired === false && lock.lastOnTs && (nowTs - lock.lastOnTs) < minSwitchSec * 1000) {
      nextDesired = true;
      nextReason = `Mindestlaufzeit aktiv (${Math.ceil((minSwitchSec * 1000 - (nowTs - lock.lastOnTs)) / 1000)}s Rest)`;
    }
    if (currentState === false && nextDesired === true && lock.lastOffTs && (nowTs - lock.lastOffTs) < minSwitchSec * 1000) {
      nextDesired = false;
      nextReason = `Mindestpause aktiv (${Math.ceil((minSwitchSec * 1000 - (nowTs - lock.lastOffTs)) / 1000)}s Rest)`;
    }

    return { desiredOn: nextDesired, reason: nextReason };
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

  async handleManualPhPumpStateChange(id, state) {
    if (!this.config.phPumpSocketStateId || id !== this.config.phPumpSocketStateId || !state) return;

    const current = !!state.val;
    const prev = !!this.lastPhPumpOn;
    const ts = Number(state.lc || state.ts || Date.now()) || Date.now();
    this.lastPhPumpOn = current;

    if (current && !prev) {
      if (!this.phManagedActive) {
        this.phManualStartedAt = ts;
      }
      return;
    }

    if (!current && prev) {
      if (!this.phManagedActive && this.phManualStartedAt) {
        const durationSec = Math.max(1, Math.round((ts - this.phManualStartedAt) / 1000));
        await this.setPhDoseHistory(this.phManualStartedAt, durationSec);
        const newCount = await this.incrementTodayDoseCount(new Date(ts));
        const msg = `[PH] Manuell dosiert | Laufzeit=${durationSec}s | Tag ${newCount}`;
        await this.setStateAsync('status.debug.lastPhStartInfo', msg, true);
        if (this.config.debugMode) this.log.info(msg);
      }
      this.phManualStartedAt = 0;
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

  matchesPumpScheduleDay(ruleDays, now = new Date()) {
    const day = now.getDay(); // 0=So,1=Mo,...6=Sa
    const days = String(ruleDays || '').trim().toLowerCase();
    if (!days || days === 'daily') return true;
    if (days === 'mon_fri') return day >= 1 && day <= 5;
    if (days === 'sat_sun') return day === 0 || day === 6;
    if (days === 'mon') return day === 1;
    if (days === 'tue') return day === 2;
    if (days === 'wed') return day === 3;
    if (days === 'thu') return day === 4;
    if (days === 'fri') return day === 5;
    if (days === 'sat') return day === 6;
    if (days === 'sun') return day === 0;
    return false;
  }

  getCirculationWindowsForDate(now = new Date()) {
    const tableRules = Array.isArray(this.config.pumpSchedules) ? this.config.pumpSchedules : [];
    const fromTable = tableRules
      .filter(rule => !!rule && rule.enabled !== false)
      .filter(rule => this.matchesPumpScheduleDay(rule.days, now))
      .map(rule => [rule.start, rule.end])
      .filter(([start, end]) => String(start || '').trim() && String(end || '').trim());

    if (fromTable.length) return fromTable;

    return [
      [this.config.pumpWindow1Start, this.config.pumpWindow1End],
      [this.config.pumpWindow2Start, this.config.pumpWindow2End],
    ];
  }

  isWithinCirculationSchedule(now = new Date()) {
    return this.getCirculationWindowsForDate(now).some(([start, end]) => inWindow(now, start, end));
  }

  getCirculationScheduleLabel(now = new Date()) {
    const tableRules = Array.isArray(this.config.pumpSchedules) ? this.config.pumpSchedules : [];
    const matching = tableRules
      .filter(rule => !!rule && rule.enabled !== false)
      .filter(rule => this.matchesPumpScheduleDay(rule.days, now));

    if (matching.length) {
      const days = String(matching[0].days || '').trim().toLowerCase();
      const map = {
        daily: 'Täglich',
        mon_fri: 'Mo-Fr',
        sat_sun: 'Sa-So',
        mon: 'Mo',
        tue: 'Di',
        wed: 'Mi',
        thu: 'Do',
        fri: 'Fr',
        sat: 'Sa',
        sun: 'So',
      };
      return map[days] || 'Zeitplan';
    }

    return 'Standard';
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
    const isManualStart = context && context.manual === true;
    const circulationHeartbeatOk = isManualStart ? true : await this.getHeartbeatOk('status.checks.circulationPump');
    const phPumpHeartbeatOk = isManualStart ? true : await this.getHeartbeatOk('status.checks.phPump');
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
      this.phManagedActive = true;
      await this.setPhStopAtTs(stopAtTs, 'Start Simulationsmodus');
      await this.setPhDoseHistory(Date.now(), sec);
      const msg = `[PH] würde dosieren | Prüfzeit ${context.checkTime || '-'} | pH=${context.phValue ?? '-'} | Laufzeit=${sec}s | Stop um ${new Date(stopAtTs).toLocaleTimeString('de-DE')}`;
      await this.setStateAsync('status.debug.lastPhStartInfo', msg, true);
      if (this.config.debugMode) this.log.info(msg);
      return true;
    }

    this.phManagedActive = true;
    const onOk = await this.forceSwitchOnCompat(pumpId);
    if (!onOk) {
      this.phManagedActive = false;
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

    const stopLater = async () => { if (!this.isShuttingDown) await this.enforcePhStopIfDue(); };
    this.trackTimeout(setTimeout(stopLater, sec * 1000));
    this.trackTimeout(setTimeout(stopLater, sec * 1000 + 1500));
    this.trackTimeout(setTimeout(stopLater, sec * 1000 + 4000));
    this.trackTimeout(setTimeout(stopLater, sec * 1000 + 8000));

    return true;
  }

  async applyControlLogic() {
    const now = new Date();
    const pumpId = this.config.circulationPumpSocketStateId;
    const standbyMode = await this.getControlBool('control.standby', this.config.standbyModeEnabled === true);
    const circulationEnabled = !standbyMode && await this.getControlBool('control.auto.circulation', this.config.enableCirculationControl !== false);
    const phEnabledMaster = !standbyMode && await this.getControlBool('control.auto.ph', this.config.enablePhControl !== false);
    const heatEnabledMaster = !standbyMode && await this.getControlBool('control.auto.heatpump', this.config.enableHeatpumpControl !== false);
    const chlorEnabledMaster = !standbyMode && await this.getControlBool('control.auto.chlor', this.config.enableChlorControl !== false);
    const pumpTarget = standbyMode ? this.isStandbyPumpActive(now) : (circulationEnabled ? this.isPumpScheduleActive(now) : false);
    const pumpState = await this.getStateSnapshot(pumpId);
    const pumpCurrent = !!(pumpState && pumpState.val);
    this.updateCirculationPumpRuntime(pumpCurrent, pumpState && (pumpState.lc || pumpState.ts));
    const lastScheduleActive = this.lastPumpScheduleActiveMemory === null ? pumpTarget : this.lastPumpScheduleActiveMemory;
    const scheduleEdge = pumpTarget !== lastScheduleActive;
    const nowMs = now.getTime();

    let pumpDecision = standbyMode ? (pumpTarget ? `Standby-Kurzlauf aktiv (${this.getStandbyDurationSec()}s)` : 'Standby aktiv') : (!circulationEnabled ? 'Steuerung deaktiviert' : (pumpTarget ? 'Zeitfenster aktiv' : 'Kein aktives Zeitfenster'));

    if (standbyMode) {
      await this.forceDependentDevicesOff('Standby aktiv');
      if (this.config.simulateMode) {
        pumpDecision = pumpTarget ? `würde EIN (Standby ${this.getStandbyDurationSec()}s, Simulationsmodus)` : 'Standby aktiv (Simulationsmodus)';
      } else if (pumpId && pumpCurrent !== pumpTarget) {
        try {
          await (pumpTarget ? this.forceSwitchOnCompat(pumpId) : this.forceSwitchOffCompat(pumpId));
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
          await (pumpTarget ? this.forceSwitchOnCompat(pumpId) : this.forceSwitchOffCompat(pumpId));
          this.suppressOwnPumpLogUntil = Date.now() + 5000;
          pumpDecision = `${pumpTarget ? 'EIN' : 'AUS'} via Zeitfensterwechsel`;
        } catch (e) {
          pumpDecision = `Schaltfehler: ${e.message || e}`;
        }
      }
    } else if (!pumpCurrent && pumpTarget) {
      if (this.config.simulateMode) {
        pumpDecision = 'würde EIN (Auto innerhalb aktivem Zeitfenster, Simulationsmodus)';
      } else if (pumpId) {
        try {
          await this.forceSwitchOnCompat(pumpId);
          this.suppressOwnPumpLogUntil = Date.now() + 5000;
          pumpDecision = 'EIN via Auto innerhalb aktivem Zeitfenster';
        } catch (e) {
          pumpDecision = `Schaltfehler: ${e.message || e}`;
        }
      }
    } else if (pumpCurrent && !pumpTarget) {
      pumpDecision = circulationEnabled ? 'EIN außerhalb Zeitfenster' : 'Manueller Override aktiv';
    } else if (pumpCurrent && pumpTarget) {
      pumpDecision = 'EIN (Zeitfenster aktiv)';
    } else {
      pumpDecision = 'AUS (kein Zeitfenster)';
    }

    this.lastPumpScheduleActiveMemory = pumpTarget;
    await this.setStateAsync('status.debug.lastPumpScheduleActive', pumpTarget, true);
    await this.setStateAsync('status.mode.active', standbyMode ? 'standby' : 'normal', true);
    await this.setStateAsync('status.auto.circulation', standbyMode ? 'STANDBY' : (circulationEnabled ? 'AKTIV' : 'AUS'), true);
    await this.setStateAsync('status.auto.chlor', standbyMode ? 'STANDBY' : (chlorEnabledMaster ? 'AKTIV' : 'AUS'), true);
    await this.setStateAsync('status.auto.ph', standbyMode ? 'STANDBY' : (phEnabledMaster ? 'AKTIV' : 'AUS'), true);
    await this.setStateAsync('status.auto.heatpump', standbyMode ? 'STANDBY' : (heatEnabledMaster ? 'AKTIV' : 'AUS'), true);
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
      shouldHeat = currentHeat;
      heatReason = currentHeat ? 'Manuell EIN (Auto AUS)' : 'Steuerung deaktiviert';
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
      heatReason = `Temperaturregelung durch WP (${poolTemp}°C >= ${targetTemp}°C)`;
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
          this.phManagedActive = false;
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


  async ensureControlState(id, def) {
    await this.ensureState(id, 'boolean', 'switch.enable', def, true);
    const cur = await this.getStateAsync(id);
    if (!cur || cur.val === null || cur.val === undefined) {
      await this.setStateAsync(id, !!def, true);
    }
  }

  async getControlBool(id, fallback) {
    const state = await this.getStateAsync(id);
    if (!state || state.val === null || state.val === undefined) return !!fallback;
    return !!state.val;
  }

  getTrendSymbol(current, prev, epsilon = 0) {
    const c = parseNum(current);
    const p = parseNum(prev);
    if (!Number.isFinite(c) || !Number.isFinite(p)) return '→';
    if (c > p + epsilon) return '↑';
    if (c < p - epsilon) return '↓';
    return '→';
  }

  avgFromHistoryValues(values) {
    const nums = (Array.isArray(values) ? values : [])
      .map(v => parseNum(v && v.val !== undefined ? v.val : v))
      .filter(v => Number.isFinite(v));
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  async fetchHistoryValues(stateId, startTs, endTs) {
    const instance = String(this.config.trendHistoryInstance || 'history.0').trim() || 'history.0';
    if (!stateId || !instance) return [];
    try {
      const res = await this.sendToAsync(instance, 'getHistory', {
        id: stateId,
        options: {
          start: startTs,
          end: endTs,
          aggregate: 'none',
          count: 500,
          ignoreNull: true
        }
      });
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.result)) return res.result;
      return [];
    } catch (e) {
      if (this.config.debugMode) this.log.debug(`[TREND] History für ${stateId} fehlgeschlagen: ${e.message || e}`);
      return [];
    }
  }

  async getHistoryTrendArrow(stateId, tolerance, nowTs = Date.now()) {
    const windowMin = Math.max(10, Number(this.config.trendWindowMin) || 60);
    const smoothMin = Math.max(1, Number(this.config.trendSmoothMin) || 5);
    const endRecent = nowTs;
    const startRecent = endRecent - smoothMin * 60000;
    const endPast = nowTs - (windowMin - smoothMin) * 60000;
    const startPast = nowTs - windowMin * 60000;

    const [recentValues, pastValues] = await Promise.all([
      this.fetchHistoryValues(stateId, startRecent, endRecent),
      this.fetchHistoryValues(stateId, startPast, endPast)
    ]);

    const recentAvg = this.avgFromHistoryValues(recentValues);
    const pastAvg = this.avgFromHistoryValues(pastValues);

    if (!Number.isFinite(recentAvg) || !Number.isFinite(pastAvg)) return '→';
    const delta = recentAvg - pastAvg;
    const eps = Number(tolerance) || 0;
    if (delta > eps) return '↑';
    if (delta < -eps) return '↓';
    return '→';
  }

  async getHistoryTrends() {
    const now = Date.now();
    if (this.trendCache && this.trendCache.data && (now - this.trendCache.ts) < 120000) {
      return this.trendCache.data;
    }
    const trends = {
      phTrend: '→',
      orpTrend: '→',
      poolTempTrend: '→',
      outsideTempTrend: '→',
      pvTrend: '→',
      feedInTrend: '→'
    };
    const tolPh = parseNum(this.config.trendTolerancePh || 0.03) || 0.03;
    const tolOrp = parseNum(this.config.trendToleranceOrp || 15) || 15;
    const tolTemp = parseNum(this.config.trendToleranceTemp || 0.3) || 0.3;

    try {
      trends.phTrend = await this.getHistoryTrendArrow(this.config.phStateId, tolPh, now);
      trends.orpTrend = await this.getHistoryTrendArrow(this.config.orpStateId, tolOrp, now);
      trends.poolTempTrend = await this.getHistoryTrendArrow(this.config.waterTempStateId, tolTemp, now);
      trends.outsideTempTrend = await this.getHistoryTrendArrow(this.config.outsideTempStateId, tolTemp, now);
      trends.pvTrend = await this.getHistoryTrendArrow(this.config.pvPowerStateId, 150, now);
      trends.feedInTrend = await this.getHistoryTrendArrow(this.config.gridFeedInStateId, 100, now);
    } catch (e) {
      if (this.config.debugMode) this.log.debug('[TREND] Berechnung fehlgeschlagen: ' + (e.message || e));
    }

    this.trendCache = { ts: now, data: trends };
    return trends;
  }

  async enforceManualPrerequisite(deviceName, turningOn) {
    if (!turningOn) return true;
    const pumpOn = await this.getBool(this.config.circulationPumpSocketStateId);
    if (pumpOn) return true;
    const msg = `${deviceName} manuell blockiert: Umwälzpumpe läuft nicht`;
    try { await this.setStateAsync('status.debug.lastStartupError', msg, true); } catch {}
    this.log.info(msg);
    return false;
  }

  async forceDependentDevicesOff(reason = '') {
    const suffix = reason ? ` (${reason})` : '';
    try {
      if (this.config.chlorinatorSocketStateId && await this.getBool(this.config.chlorinatorSocketStateId)) {
        await this.forceSwitchOffCompat(this.config.chlorinatorSocketStateId);
      }
    } catch (e) {
      this.log.warn('Chlorinator AUS fehlgeschlagen' + suffix + ': ' + (e.message || e));
    }
    try {
      if (this.config.phPumpSocketStateId && await this.getBool(this.config.phPumpSocketStateId)) {
        await this.forceSwitchOffCompat(this.config.phPumpSocketStateId);
      }
    } catch (e) {
      this.log.warn('pH-Pumpe AUS fehlgeschlagen' + suffix + ': ' + (e.message || e));
    }
    try {
      if (this.config.heatpumpPowerStateId && await this.getBool(this.config.heatpumpPowerStateId)) {
        await this.forceSwitchOffCompat(this.config.heatpumpPowerStateId);
      }
    } catch (e) {
      this.log.warn('Wärmepumpe AUS fehlgeschlagen' + suffix + ': ' + (e.message || e));
    }
    await this.setStateIfChanged('control.device.chlorinator', false, true);
    await this.setStateIfChanged('control.device.phPump', false, true);
    await this.setStateIfChanged('control.device.heatpump', false, true);
  }

  async resetManualBlockers(reason = '') {
    const suffix = reason ? ` (${reason})` : '';
    try { await this.setStateIfChanged('control.device.circulation', false, true); } catch (e) { this.log.warn('Reset control.device.circulation fehlgeschlagen' + suffix + ': ' + (e.message || e)); }
    try { await this.setStateIfChanged('control.device.chlorinator', false, true); } catch (e) { this.log.warn('Reset control.device.chlorinator fehlgeschlagen' + suffix + ': ' + (e.message || e)); }
    try { await this.setStateIfChanged('control.device.phPump', false, true); } catch (e) { this.log.warn('Reset control.device.phPump fehlgeschlagen' + suffix + ': ' + (e.message || e)); }
    try { await this.setStateIfChanged('control.device.heatpump', false, true); } catch (e) { this.log.warn('Reset control.device.heatpump fehlgeschlagen' + suffix + ': ' + (e.message || e)); }
    try { await this.setStateIfChanged('control.ph.manualStart', false, true); } catch {}
  }

  async syncDeviceControlStates() {
    try { await this.setStateIfChanged('control.device.circulation', await this.getBool(this.config.circulationPumpSocketStateId), true); } catch {}
    try { await this.setStateIfChanged('control.device.chlorinator', await this.getBool(this.config.chlorinatorSocketStateId), true); } catch {}
    try { await this.setStateIfChanged('control.device.phPump', await this.getBool(this.config.phPumpSocketStateId), true); } catch {}
    try { await this.setStateIfChanged('control.device.heatpump', await this.getBool(this.config.heatpumpPowerStateId), true); } catch {}
  }


  async syncControlStates() {
    const standby = await this.getControlBool('control.standby', this.config.standbyModeEnabled === true);
    if (standby) {
      const autoIds = [
        'control.auto.circulation',
        'control.auto.chlor',
        'control.auto.ph',
        'control.auto.heatpump'
      ];
      for (const id of autoIds) {
        try {
          await this.setStateIfChanged(id, false, true);
        } catch (e) {
          this.log.warn(`Control-State ${id} konnte nicht synchronisiert werden: ${e.message || e}`);
        }
      }
    }
    try { await this.setStateAsync('status.auto.circulation', (await this.getControlBool('control.auto.circulation', this.config.enableCirculationControl !== false)) ? 'AKTIV' : 'AUS', true); } catch {}
    try { await this.setStateAsync('status.auto.chlor', (await this.getControlBool('control.auto.chlor', this.config.enableChlorControl !== false)) ? 'AKTIV' : 'AUS', true); } catch {}
    try { await this.setStateAsync('status.auto.ph', (await this.getControlBool('control.auto.ph', this.config.enablePhControl !== false)) ? 'AKTIV' : 'AUS', true); } catch {}
    try { await this.setStateAsync('status.auto.heatpump', (await this.getControlBool('control.auto.heatpump', this.config.enableHeatpumpControl !== false)) ? 'AKTIV' : 'AUS', true); } catch {}
  }

  async onReady() {
    try {
      await this.ensureState('info.connection', 'boolean', 'indicator.connected', false, false);
      await this.ensureState('status.debug.lastCycle', 'string', 'text', '', false);
      await this.ensureState('status.debug.lastStartupError', 'string', 'text', '', false);
      await this.ensureAlertStates();
      await this.ensureControlState('control.standby', this.config.standbyModeEnabled === true);
      await this.ensureControlState('control.auto.circulation', this.config.enableCirculationControl !== false);
      await this.ensureControlState('control.auto.chlor', this.config.enableChlorControl !== false);
      await this.ensureControlState('control.auto.ph', this.config.enablePhControl !== false);
      await this.ensureControlState('control.auto.heatpump', this.config.enableHeatpumpControl !== false);
      await this.ensureState('control.ph.manualDoseSec', 'number', 'value.interval', Math.max(1, parseNum(this.config.phDoseDurationSec || 30)), true);
      await this.setStateIfChanged('control.ph.manualDoseSec', Math.max(1, parseNum(this.config.phDoseDurationSec || 30)), true);
      await this.ensureState('control.ph.manualStart', 'boolean', 'button', false, true);
      await this.ensureState('control.device.circulation', 'boolean', 'switch', false, true);
      await this.ensureState('control.device.chlorinator', 'boolean', 'switch', false, true);
      await this.ensureState('control.device.phPump', 'boolean', 'switch', false, true);
      await this.ensureState('control.device.heatpump', 'boolean', 'switch', false, true);
      await this.ensureState('control.heatpump.setTemp', 'number', 'level.temperature', 0, true);
      await this.ensureState('control.heatpump.resetLock', 'boolean', 'button', false, true);
      await this.resetManualBlockers('Adapterstart');
      this.clearPendingRenderTimeouts('Adapterstart');
      this.resetHeatpumpLocks('Adapterstart');
      await this.forceDependentDevicesOff('Adapterstart Recovery');
      await this.setStateAsync('info.connection', true, true);
      await this.subscribeConfiguredStates();
      try { this.subscribeStates('control.*'); } catch {}
      try { this.subscribeStates('control.device.*'); } catch {}
      try { this.subscribeStates('control.heatpump.*'); } catch {}
      try { this.subscribeStates('control.ph.*'); } catch {}
      this.beginControlTransition(4000);
      await this.applyControlLogic();
      await this.syncControlStates();
      await this.syncDeviceControlStates();
      if (this.config.circulationPumpSocketStateId) {
        const initialPumpState = await this.getStateSnapshot(this.config.circulationPumpSocketStateId);
        this.updateCirculationPumpRuntime(!!(initialPumpState && initialPumpState.val), initialPumpState && (initialPumpState.lc || initialPumpState.ts));
      }
      if (this.config.phPumpSocketStateId) {
        const initialPhPumpState = await this.getStateSnapshot(this.config.phPumpSocketStateId);
        this.lastPhPumpOn = !!(initialPhPumpState && initialPhPumpState.val);
        this.phManualStartedAt = this.lastPhPumpOn ? Number((initialPhPumpState && (initialPhPumpState.lc || initialPhPumpState.ts)) || Date.now()) : 0;
      }
      await this.updateComputedStates();
      await this.runHeartbeatChecks();
      await this.applyDependencyRules();
      await this.renderVis();
      await this.logStartupSummary();
      const pollMin = Math.max(1, Number(this.config.pollIntervalMin) || 1);
      if (this.phStopWatcher) clearInterval(this.phStopWatcher);
    this.phStopWatcher = setInterval(async () => {
      await this.enforcePhStopIfDue();
      if (this.config.standbyModeEnabled === true && typeof this.applyControlLogic === 'function' && !this.isControlTransitionActive()) {
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
    if (id && id.startsWith(`${this.namespace}.control.`)) {
      if (state.ack === true) {
        return;
      }
      try {
        const standbyActiveNow = await this.getControlBool('control.standby', this.config.standbyModeEnabled === true);

        if (id === `${this.namespace}.control.standby`) {
          this.beginControlTransition(10000);
          await this.resetManualBlockers('Standby gewechselt');
          this.clearPendingRenderTimeouts('Standby gewechselt');
          this.resetHeatpumpLocks('Standby gewechselt');
          if (!!state.val === true) {
            await this.setStateIfChanged('control.auto.circulation', false, false);
            await this.setStateIfChanged('control.auto.chlor', false, false);
            await this.setStateIfChanged('control.auto.ph', false, false);
            await this.setStateIfChanged('control.auto.heatpump', false, false);
            await this.forceDependentDevicesOff('Standby aktiv');
            try {
              if (this.config.circulationPumpSocketStateId) {
                await this.forceSwitchOffCompat(this.config.circulationPumpSocketStateId);
                await this.setStateIfChanged('control.device.circulation', false, true);
              }
            } catch {}
          }
          await this.forceImmediateRender();
          this.queueDelayedRefresh(1800);
          return;
        }

        const autoIds = [
          `${this.namespace}.control.auto.circulation`,
          `${this.namespace}.control.auto.chlor`,
          `${this.namespace}.control.auto.ph`,
          `${this.namespace}.control.auto.heatpump`
        ];
        if (autoIds.includes(id)) {
          this.beginControlTransition(3500);
          const key = id.replace(`${this.namespace}.control.auto.`, '');
          if (!!state.val === true) {
            if (standbyActiveNow) {
              await this.setStateIfChanged('control.standby', false, false);
            }
            await this.resetManualBlockers(`Auto ${key} EIN`);
          } else {
            if (key === 'chlor') await this.setStateIfChanged('control.device.chlorinator', false, true);
            if (key === 'ph') await this.setStateIfChanged('control.device.phPump', false, true);
            if (key === 'heatpump') await this.setStateIfChanged('control.device.heatpump', false, true);
          }
          await this.forceImmediateRender();
          this.queueDelayedRefresh(1500);
          return;
        }

        if (id === `${this.namespace}.control.heatpump.resetLock` && !!state.val === true) {
          this.beginControlTransition(10000);
          this.clearPendingRenderTimeouts('WP Reset');
          this.resetHeatpumpLocks('manueller Reset');
          await this.setStateIfChanged('control.heatpump.resetLock', false, false);
          await this.forceImmediateRender();
          this.queueDelayedRefresh(1000);
          return;
        }

        if ((id === `${this.namespace}.control.ph.manualStart` && !!state.val === true) || (id === `${this.namespace}.control.ph.manualTrigger` && Number(state.val) > 0)) {
          this.beginControlTransition(3500);
          const nowTs = Date.now();
          this.lastManualPhTriggerTs = this.lastManualPhTriggerTs || 0;
          if (nowTs - this.lastManualPhTriggerTs < 1500) {
            await this.setStateIfChanged('control.ph.manualStart', false, false);
            await this.setStateIfChanged('control.ph.manualTrigger', 0, false);
            return;
          }
          if (this.phManagedActive) {
            if (this.config.debugMode) this.log.info('[PH] Manueller Start ignoriert: Dosierung läuft bereits');
            await this.setStateIfChanged('control.ph.manualStart', false, false);
            await this.setStateIfChanged('control.ph.manualTrigger', 0, false);
            return;
          }
          this.lastManualPhTriggerTs = nowTs;
          const manualSecState = await this.getStateAsync('control.ph.manualDoseSec');
          const manualSec = Math.max(1, Number(manualSecState && manualSecState.val) || 30);
          const ok = await this.runDosePumpOnce(manualSec, { checkTime: 'MANUELL', phValue: 'manuell', manual: true });
          if (ok) {
            await this.incrementTodayDoseCount(new Date());
          }
          await this.setStateIfChanged('control.ph.manualStart', false, false);
          await this.setStateIfChanged('control.ph.manualTrigger', 0, false);
          await this.applyControlLogic();
          await this.forceImmediateRender();
          this.queueDelayedRefresh(1200);
          return;
        }

        if (id === `${this.namespace}.control.device.circulation`) {
          this.beginControlTransition(3500);
          if (standbyActiveNow) {
            await this.resetManualBlockers('Standby blockiert manuell');
          } else {
            await this.setStateIfChanged('control.auto.circulation', false, false);
            const ok = !!state.val ? await this.forceSwitchOnCompat(this.config.circulationPumpSocketStateId) : await this.forceSwitchOffCompat(this.config.circulationPumpSocketStateId);
            await this.setStateIfChanged('control.device.circulation', !!ok && !!state.val, true);
            if (!state.val) {
              await this.forceDependentDevicesOff('Umwälzpumpe AUS');
            }
          }
          await this.forceImmediateRender();
          this.queueDelayedRefresh(1200);
          return;
        }

        if (id === `${this.namespace}.control.device.chlorinator`) {
          this.beginControlTransition(3500);
          if (standbyActiveNow) {
            await this.resetManualBlockers('Standby blockiert manuell');
          } else {
            await this.setStateIfChanged('control.auto.chlor', false, false);
            const allowed = await this.enforceManualPrerequisite('Chlorinator', !!state.val);
            if (!allowed) {
              await this.setStateIfChanged('control.device.chlorinator', false, true);
            } else {
              const ok = !!state.val ? await this.forceSwitchOnCompat(this.config.chlorinatorSocketStateId) : await this.forceSwitchOffCompat(this.config.chlorinatorSocketStateId);
              await this.setStateIfChanged('control.device.chlorinator', !!state.val, true);
            }
          }
          await this.applyControlLogic();
          await this.syncControlStates();
          await this.syncDeviceControlStates();
          this.queueDelayedRefresh(1200);
          await this.renderVis();
          return;
        }

        if (id === `${this.namespace}.control.device.phPump`) {
          this.beginControlTransition(3500);
          if (standbyActiveNow) {
            await this.resetManualBlockers('Standby blockiert manuell');
          } else {
            await this.setStateIfChanged('control.auto.ph', false, false);
            const allowed = await this.enforceManualPrerequisite('pH-Dosierpumpe', !!state.val);
            if (!allowed) {
              await this.setStateIfChanged('control.device.phPump', false, true);
            } else {
              const ok = !!state.val ? await this.forceSwitchOnCompat(this.config.phPumpSocketStateId) : await this.forceSwitchOffCompat(this.config.phPumpSocketStateId);
              await this.setStateIfChanged('control.device.phPump', !!state.val, true);
            }
          }
          await this.applyControlLogic();
          await this.syncControlStates();
          await this.syncDeviceControlStates();
          this.queueDelayedRefresh(1200);
          await this.renderVis();
          return;
        }

        if (id === `${this.namespace}.control.device.heatpump`) {
          this.beginControlTransition(3500);
          if (standbyActiveNow) {
            await this.resetManualBlockers('Standby blockiert manuell');
          } else {
            await this.setStateIfChanged('control.auto.heatpump', false, false);
            const allowed = await this.enforceManualPrerequisite('Wärmepumpe', !!state.val);
            if (!allowed) {
              await this.setStateIfChanged('control.device.heatpump', false, true);
            } else {
              const ok = !!state.val ? await this.forceSwitchOnCompat(this.config.heatpumpPowerStateId) : await this.forceSwitchOffCompat(this.config.heatpumpPowerStateId);
              await this.setStateIfChanged('control.device.heatpump', !!state.val, true);
            }
          }
          await this.applyControlLogic();
          await this.syncControlStates();
          await this.syncDeviceControlStates();
          this.queueDelayedRefresh(1200);
          await this.renderVis();
          return;
        }

        if (id === `${this.namespace}.control.heatpump.setTemp`) {
          this.beginControlTransition(3500);
          const hpOn = await this.getBool(this.config.heatpumpPowerStateId);
          if (!hpOn) {
            await this.setStateAsync('status.debug.lastStartupError', 'Solltemperatur nur bei laufender Wärmepumpe änderbar', true);
          } else if (this.config.heatpumpSetTempStateId) {
            const setVal = Math.max(10, Math.min(40, Number(state.val) || 0));
            await this.setForeignStateAsync(this.config.heatpumpSetTempStateId, setVal, false);
          }
          await this.applyControlLogic();
          await this.syncControlStates();
          await this.syncDeviceControlStates();
          this.queueDelayedRefresh(1200);
          await this.renderVis();
          return;
        }

        await this.applyControlLogic();
        await this.syncControlStates();
        await this.syncDeviceControlStates();
        await this.renderVis();
      } catch (e) {
        this.log.warn(`Control-State konnte nicht angewendet werden: ${e.message || e}`);
      }
      return;
    }
    if (this.ruleCompareIds && this.ruleCompareIds.includes(id)) {
      await this.applyDependencyRules(id);
    }
    await this.handleManualPhPumpStateChange(id, state);
    if (this.monitoredIds.includes(id)) {
      this.debug(`State geändert: ${id}`);
      this.queueRender();
      const delayedRefreshIds = [
        this.config.circulationPumpSocketStateId,
        this.config.chlorinatorSocketStateId,
        this.config.phPumpSocketStateId,
        this.config.heatpumpPowerStateId
      ].filter(Boolean);
      if (delayedRefreshIds.includes(id)) {
        const boolVal = await this.getBool(id);
        if (id === this.config.circulationPumpSocketStateId) await this.setStateIfChanged('control.device.circulation', boolVal, true);
        if (id === this.config.chlorinatorSocketStateId) await this.setStateIfChanged('control.device.chlorinator', boolVal, true);
        if (id === this.config.phPumpSocketStateId) await this.setStateIfChanged('control.device.phPump', boolVal, true);
        if (id === this.config.heatpumpPowerStateId) await this.setStateIfChanged('control.device.heatpump', boolVal, true);
        if (!this.isControlTransitionActive()) {
          await this.applyControlLogic();
          await this.syncControlStates();
          await this.syncDeviceControlStates();
        }
        this.queueDelayedRefresh(this.isControlTransitionActive() ? 2600 : 1800);
      }
    }
  }

  async onUnload(callback) {
    try {
      this.isShuttingDown = true;
      if (this.timer) clearInterval(this.timer);
      for (const h of Array.from(this.pendingTimeouts)) {
        try { clearTimeout(h); } catch {}
      }
      this.pendingTimeouts.clear();
      try { await this.setStateAsync('info.connection', false, true); } catch {}
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

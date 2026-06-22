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
      const ageMin = Number(((Date.now() - refTs) / 60000).toFixed(1));
      if (ageMin <= maxAge) {
        return { ok: true, severity: 'ok', text: `${label}: Heartbeat OK (${ageMin} min)`, ageMin, stateId };
      }
      const severity = ageMin > maxAge * 2 ? 'error' : 'warn';
      return { ok: false, severity, text: `${label}: WARNUNG | letzte Meldung vor ${ageMin} min`, ageMin, stateId };
    } catch (e) {
      return { ok: false, severity: 'error', text: `${label}: Heartbeat-Prüfung fehlgeschlagen`, ageMin: null, stateId, error: String(e && (e.message || e)) };
    }
  }

  async runHeartbeatChecks() {
    const checks = [
      { key: 'circulation', label: 'Umwälzpumpe', id: this.config.circulationPumpHeartbeatStateId, maxAge: this.config.circulationPumpHeartbeatMaxAgeMin },
      { key: 'chlorinator', label: 'Chlorinator', id: this.config.chlorinatorHeartbeatStateId, maxAge: this.config.chlorinatorHeartbeatMaxAgeMin },
      { key: 'phPump', label: 'pH-Dosierpumpe', id: this.config.phPumpHeartbeatStateId, maxAge: this.config.phPumpHeartbeatMaxAgeMin },
      { key: 'heatpump', label: 'Wärmepumpe', id: this.config.heatpumpHeartbeatStateId, maxAge: this.config.heatpumpHeartbeatMaxAgeMin },
    ];

    const messages = [];
    const summary = {};
    const severityRank = { ok: 0, warn: 1, error: 2 };
    let overall = 'ok';

    for (const c of checks) {
      const result = await this.evaluateHeartbeat(c.label, c.id, c.maxAge);
      summary[c.key] = result;
      if (severityRank[result.severity] > severityRank[overall]) overall = result.severity;
      if (!result.ok) {
        messages.push(`[CHECK] ${result.text}`);
      }
    }

    await this.ensureState('status.heartbeat.summary', 'string', 'text', 'ok', false);
    await this.ensureState('status.heartbeat.detailsJson', 'string', 'json', '{}', false);
    await this.setStateAsync('status.heartbeat.summary', overall, true);
    await this.setStateAsync('status.heartbeat.detailsJson', JSON.stringify(summary), true);

    for (const msg of messages) {
      this.log.warn(msg);
      await this.sendAlert('heartbeat', msg);
    }
  }

  async sendAlert(type, message) {
    if (!this.config.enableAlerts) return;
    const lockKey = `${type}:${message}`;
    const repeatLockMin = Math.max(1, Number(this.config.alertRepeatLockMin) || 30);
    const now = Date.now();
    if (this.alertLockMemory[lockKey] && now - this.alertLockMemory[lockKey] < repeatLockMin * 60000) return;
    this.alertLockMemory[lockKey] = now;

    this.log.info(`[ALERT] ${message}`);

    if (this.config.alertWhatsappEnabled && this.config.alertWhatsappInstance && this.config.alertWhatsappTo) {
      try {
        await this.sendToAsync(this.config.alertWhatsappInstance, 'send', {
          to: this.config.alertWhatsappTo,
          message,
        });
      } catch (e) {
        this.log.warn('WhatsApp Alert fehlgeschlagen: ' + (e.message || e));
      }
    }

    if (this.config.alertTelegramEnabled && this.config.alertTelegramInstance && this.config.alertTelegramTo) {
      try {
        await this.sendToAsync(this.config.alertTelegramInstance, {
          user: this.config.alertTelegramTo,
          text: message,
        });
      } catch (e) {
        this.log.warn('Telegram Alert fehlgeschlagen: ' + (e.message || e));
      }
    }

    if (this.config.alertEmailEnabled && this.config.alertEmailInstance && this.config.alertEmailTo) {
      try {
        await this.sendToAsync(this.config.alertEmailInstance, 'send', {
          to: this.config.alertEmailTo,
          subject: 'Poolsteuerung Alert',
          text: message,
        });
      } catch (e) {
        this.log.warn('E-Mail Alert fehlgeschlagen: ' + (e.message || e));
      }
    }
  }

  parseHHMM(v) {
    const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]); const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
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
    const w = this.getStandbyRunWindow(now);
    if (!w) return false;
    return now >= w.start && now < w.end;
  }

  getNextStandbyRun(now = new Date()) {
    const mins = this.parseHHMM(this.config.standbyRunTime || '12:00');
    if (mins === null) return null;
    const next = new Date(now);
    next.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  async applyDependencyRules() {
    const rules = Array.isArray(this.config.dependencyRules) ? this.config.dependencyRules : [];
    for (const rule of rules) {
      if (!rule || rule.enabled === false || !rule.compareStateId || !rule.targetStateId) continue;
      try {
        const cmp = await this.getStateSnapshot(rule.compareStateId);
        const cmpVal = cmp ? cmp.val : undefined;
        let matched = false;
        const op = String(rule.operator || 'eq');
        const compareValue = rule.compareValue;
        if (op === 'istrue') matched = this.boolish(cmpVal) === true;
        else if (op === 'isfalse') matched = this.boolish(cmpVal) === false;
        else if (op === 'eq') matched = String(cmpVal) == String(compareValue);
        else if (op === 'neq') matched = String(cmpVal) != String(compareValue);
        else {
          const a = Number(String(cmpVal).replace(',', '.'));
          const b = Number(String(compareValue).replace(',', '.'));
          if (Number.isFinite(a) && Number.isFinite(b)) {
            if (op === 'gt') matched = a > b;
            if (op === 'gte') matched = a >= b;
            if (op === 'lt') matched = a < b;
            if (op === 'lte') matched = a <= b;
          }
        }
        const raw = matched ? rule.thenValue : rule.elseValue;
        const targetObj = await this.getForeignObjectAsync(rule.targetStateId);
        const converted = this.convertValueForTarget(raw, targetObj && targetObj.common ? targetObj.common.type : 'mixed');
        await this.setForeignStateAsync(rule.targetStateId, converted, false);
        if (rule.logEnabled) {
          this.log.info(`[RULE] ${rule.name || rule.targetStateId}: ${rule.compareStateId} ${rule.operator} ${compareValue} => ${matched ? 'THEN' : 'ELSE'} | ${rule.targetStateId}=${converted}`);
        }
      } catch (e) {
        this.log.warn(`[RULE] Fehler bei ${rule.name || rule.targetStateId}: ${e.message || e}`);
      }
    }
  }

  boolish(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = String(v ?? '').trim().toLowerCase();
    if (['true', '1', 'on', 'ein', 'yes', 'ja'].includes(s)) return true;
    if (['false', '0', 'off', 'aus', 'no', 'nein'].includes(s)) return false;
    return false;
  }

  convertValueForTarget(raw, type) {
    if (type === 'boolean') return this.boolish(raw);
    if (type === 'number') {
      const n = Number(String(raw).replace(',', '.'));
      return Number.isFinite(n) ? n : 0;
    }
    return raw;
  }

  inPhCheckWindow(now = new Date()) {
    const times = String(this.config.phCheckTimes || '').split(',').map(s => s.trim()).filter(Boolean);
    const curMin = now.getHours() * 60 + now.getMinutes();
    return times.some(t => {
      const mins = this.parseHHMM(t);
      return mins !== null && curMin >= mins && curMin < mins + 1;
    });
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
      return `<div class="status-item compact ${state ? 'on' : 'off'}"><div class="status-line"><span class="name">${esc(name)}</span><span class="state">${state ? 'EIN' : 'AUS'}</span></div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
    }
    return `<div class="status-item ${state ? 'on' : 'off'}"><div class="name">${esc(name)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}<div class="state">${state ? 'EIN' : 'AUS'}</div></div>`;
  }

  buildTabletHtml(data) {
    const hero = this.buildHeroCard(data);
    const quick = (label, value, cls = '') => `<div class="quick-card ${cls}"><div class="quick-label">${esc(label)}</div><div class="quick-value">${esc(value)}</div></div>`;
    const autoBtn = (label, key, active) => `<button class="action-btn js-auto-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="action-name">${esc(label)}</span><span class="action-state">${active ? 'AKTIV' : 'AUS'}</span></button>`;
    const deviceBtn = (label, key, active) => `<button class="action-btn js-device-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="action-name">${esc(label)}</span><span class="action-state">${active ? 'EIN' : 'AUS'}</span></button>`;
    return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>
:root{--bg:#0b1320;--card:#0f1b2d;--card2:#13243c;--text:#fff;--muted:#cbd5e1;--accent:#57b9ff;--ok:#5dd46f;--warn:#ffb067;--bad:#ff7e73;--shadow:0 10px 26px rgba(0,0,0,.35)}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:radial-gradient(circle at top left, rgba(89,188,255,.18), transparent 28%),#0a1323;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:8px;display:grid;grid-template-columns:280px 340px 1fr 150px;gap:8px}
.card{background:linear-gradient(180deg,#10203a 0%, #0a1323 100%);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:10px;box-shadow:var(--shadow)}
.hero{grid-column:1/span 1;display:grid;gap:8px}
.mid{grid-column:2/span 1;display:grid;gap:8px}
.right{grid-column:3/span 1;display:grid;gap:8px}
.side{grid-column:4/span 1;display:grid;gap:8px}
.titleRow{display:flex;justify-content:space-between;align-items:flex-start}.title{font-size:20px;font-weight:800;display:flex;align-items:baseline;gap:8px}.ver{font-size:11px;color:#b9d7ff;font-weight:700}.mode{font-size:14px;font-weight:800;padding:4px 10px;border-radius:999px;background:linear-gradient(180deg,#334f84,#1b3158);border:1px solid rgba(255,255,255,.12)}.updated{font-size:12px;color:#d2dded;text-align:right}
.tempWrap{display:flex;align-items:flex-end;gap:8px}.tempVal{font-size:68px;font-weight:900;line-height:.9}.tempUnit{font-size:20px;padding-bottom:10px;color:#dbeafe}
.trackWrap{margin-top:2px}.track{position:relative;height:10px;border-radius:999px;background:linear-gradient(90deg,#46b3ff 0%, #58d27a 55%, #f5c04f 78%, #ff7f6f 100%)}.track .target{position:absolute;top:50%;left:${Math.max(0,Math.min(100,((parseNum(data.targetTemp)-15)/(32-15))*100))}%;width:4px;height:18px;background:#fff;border:1px solid #1e3a5f;border-radius:999px;transform:translate(-50%,-50%)}.track .dot{position:absolute;top:50%;left:${Math.max(0,Math.min(100,((parseNum(data.poolTemp)-15)/(32-15))*100))}%;width:15px;height:15px;border-radius:50%;background:#dbeafe;border:4px solid #314a72;transform:translate(-50%,-50%)}.trackLabels{display:flex;justify-content:space-between;font-size:12px;color:#d2dded;margin-top:4px}.trackTarget{font-size:12px;color:#d2dded;text-align:center;margin-top:2px}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}.metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px}.metric.warn{background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.04))}.metric-label{font-size:13px;color:#d9e5f5}.metric-value{font-size:18px;font-weight:900;margin-top:4px}.metric-sub{font-size:12px;color:#d9e5f5;margin-top:2px}.metric-badge{display:inline-flex;align-items:center;justify-content:center;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.12);font-size:12px;font-weight:800;margin-top:8px}.metric-badge.ok{background:rgba(93,212,111,.18);color:#90f3a3}.metric-badge.warn{background:rgba(255,176,103,.18);color:#ffd39e}
.section{font-size:13px;font-weight:800;color:#fff;margin-bottom:6px}.section.green{color:#a9f5b5}.section.orange{color:#ffd39e}
.list{display:grid;gap:6px}.status-item{background:linear-gradient(90deg,rgba(255,255,255,.06),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px}.status-item .name{font-size:12px;font-weight:700}.status-item .hint{font-size:10px;color:#cbd5e1;margin-top:2px}.status-item .state{font-size:14px;font-weight:900;margin-top:6px}.status-item.on .state{color:#6de27e}.status-item.off .state{color:#ff8d7b}.status-item.compact .status-line{display:flex;justify-content:space-between;gap:8px}.status-item.compact .state{margin-top:0}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.mini{background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px}.mini .label{font-size:11px;color:#d9e5f5}.mini .value{font-size:13px;font-weight:900;margin-top:4px;white-space:pre-line}
.side .toggle{display:flex;align-items:center;gap:8px;color:#dbeafe;font-size:12px}.switch{position:relative;width:110px;height:34px;border-radius:999px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.1)}.switch::after{content:'';position:absolute;top:3px;left:${'${on ? 55px : 3px}'};width:48px;height:26px;border-radius:999px;background:#e5e7eb;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.btnGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.action-btn{appearance:none;border:none;cursor:pointer;text-align:left;padding:12px 12px;border-radius:14px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;gap:3px}.action-name{font-size:16px;font-weight:800}.action-state{font-size:11px;font-weight:800}.action-btn.is-on .action-name,.action-btn.is-on .action-state{color:#67dd7c}.action-btn.is-off .action-name,.action-btn.is-off .action-state{color:#ff8d7b}
.buttonBar{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pill-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:14px 16px;border-radius:999px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);color:#fff;font-weight:800;border:1px solid rgba(255,255,255,.09);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28)}
.quick-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.quick-card{background:#fff;color:#0f172a;border-radius:14px;padding:10px;border:1px solid rgba(15,23,42,.08)}.quick-label{font-size:12px;color:#64748b;font-weight:700}.quick-value{font-size:18px;font-weight:900;margin-top:4px}.quick-wide{grid-column:span 2}.manual-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:10px 12px;border-radius:999px;min-height:52px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}.manual-btn span{font-size:17px}.manual-btn small{font-size:12px;color:#dbeafe}
.wallbox-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.footer-note{font-size:11px;color:#64748b;margin-top:10px;line-height:1.45}
</style></head><body>
<div class="wrap">
  ${hero}
    <div class="card">
      <div class="section green">Auto &amp; Wallbox</div>
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
  <div class="mid">
    <div class="card"><div class="section">Energie & Steuerung</div><div class="list">
      ${this.statusItemHtml('Pumpe Auto', '', data.autoCirculationControl, true)}
      ${this.statusItemHtml('Chlor Auto', '', data.autoChlorControl, true)}
      ${this.statusItemHtml('pH Auto', '', data.autoPhControl, true)}
      ${this.statusItemHtml('WP Auto', '', data.autoHeatpumpControl, true)}
      <div class="status-item compact"><div class="status-line"><span class="name">PV-Leistung</span><span class="state" style="color:#fff">${esc(data.pv)} W</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Netzeinspeisung</span><span class="state" style="color:#fff">${esc(data.feedIn)} W</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Netzbezug</span><span class="state" style="color:#fff">${esc(data.gridSupply)} W</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Batterie SoC</span><span class="state" style="color:#fff">${esc(data.battery)} %</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">WP Freigabe</span><span class="state" style="color:#fff">${esc(data.heatDecision)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Chlor Freigabe</span><span class="state" style="color:#fff">${esc(data.chlorDecision)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Zeitplan</span><span class="state" style="color:#fff">${esc(data.pumpDecision)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">pH Prüfung</span><span class="state" style="color:#fff">${esc(data.phDecision)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">pH Zeiten</span><span class="state" style="color:#fff">${esc(data.phCheckTimes)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Standby nächster Lauf</span><span class="state" style="color:#fff">${esc(data.standbyNext)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Letzte Dosierung</span><span class="state" style="color:#fff">${esc(data.phLastDoseDurationSec)} s</span></div></div>
    </div></div>
  </div>
  <div class="right">
    <div class="card"><div class="section green">Aktoren & Status</div><div class="list">
      ${this.statusItemHtml('Umwälzpumpe', 'IST-Zustand', data.pumpOn)}
      ${this.statusItemHtml('Chlorinator', 'ORP-Regelung', data.chlorOn)}
      ${this.statusItemHtml('pH-Dosierpumpe', 'Prüfzeiten', data.phPumpOn)}
      ${this.statusItemHtml('Wärmepumpe', 'PV-Freigabe', data.heatpumpOn)}
    </div></div>
    <div class="card"><div class="section orange">Zusatzwerte</div><div class="info-grid">
      <div class="mini"><div class="label">Zeitplan</div><div class="value">${esc(data.pumpDecision.includes('Zeitfenster aktiv') ? 'AKTIV' : (data.pumpDecision.includes('Standby') ? 'STANDBY' : (data.pumpDecision.includes('Steuerung deaktiviert') ? 'INAKTIV' : 'INAKTIV')))}</div></div>
      <div class="mini"><div class="label">PV Schwelle</div><div class="value">${esc(data.pvThreshold)} W</div></div>
      <div class="mini"><div class="label">ORP Grenzen</div><div class="value">${esc(data.orpOnThreshold)} / ${esc(data.orpOffThreshold)}</div></div>
      <div class="mini"><div class="label">pH Tag</div><div class="value">${esc(data.phDailyCount)}</div></div>
      <div class="mini"><div class="label">Pumpe ml/min</div><div class="value">${esc(data.phPumpFlowMlPerMin)}</div></div>
      <div class="mini"><div class="label">ml je 0,1 / 10m³</div><div class="value">${esc(data.phDoseMlPer01Per10m3)}</div></div>
      <div class="mini"><div class="label">Poolvolumen</div><div class="value">${esc(data.volume)} m³</div></div>
      <div class="mini"><div class="label">WP Lüfter</div><div class="value">${esc(data.heatpumpFanPercent)}</div></div>
      <div class="mini"><div class="label">WP Modus</div><div class="value">${esc(data.heatpumpMode)}</div></div>
      <div class="mini"><div class="label">Granulat manuell</div><div class="value">${esc(data.manualGranulateText)}</div></div>
    </div></div>
  </div>
  <div class="side">
    ${this.switchHtml('Standby', 'standby', data.standbyControl)}
    ${this.switchHtml('Auto Pumpe', 'circulation', data.autoCirculationControl, true)}
    ${this.switchHtml('Auto Chlor', 'chlor', data.autoChlorControl, true)}
    ${this.switchHtml('Auto PH', 'ph', data.autoPhControl, true)}
    ${this.switchHtml('Auto Wärmepumpe', 'heatpump', data.autoHeatpumpControl, true)}
  </div>
  <div class="card" style="grid-column:1 / span 4;"><div class="section orange">Manuelle Aktionen</div><div class="buttonBar">
    <button type="button" class="manual-btn js-manual-dose-btn" data-sec="${Number(data.phManualDoseSec || 30) || 30}"><span>PH Manuell</span><small>${esc(data.phManualDoseSec)} Sek.</small></button>
    <div class="buttonBar">
      <button type="button" class="pill-btn js-temp-btn" data-delta="-0.5">Solltemperatur -0,5°C</button>
      <button type="button" class="pill-btn js-temp-btn" data-delta="0.5">Solltemperatur +0,5°C</button>
    </div>
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
    const ok=await window.poolSetState(ns + '.control.ph.manualStart', true);
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
  const bind = () => {
    document.querySelectorAll('.js-auto-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolToggleControl(el.dataset.key, el.dataset.current==='1');return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
    document.querySelectorAll('.js-device-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolToggleState(el.dataset.key||'', el.dataset.current==='1');return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
    document.querySelectorAll('.js-standby-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolToggleStandby(el.dataset.current==='1');return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
    document.querySelectorAll('.js-manual-dose-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolPhManualDose(Number(el.dataset.sec||30));return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
    document.querySelectorAll('.js-temp-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolAdjustSetTemp(Number(el.dataset.delta||0));return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
</script></body></html>`;
  }

  switchHtml(label, key, on, isAuto = false) {
    return `<div class="toggle"><div class="switch ${on ? 'on' : ''} js-${isAuto ? 'auto' : 'standby'}-btn" data-key="${esc(key)}" data-current="${on ? '1' : '0'}"></div><div>${esc(label)}</div></div>`;
  }

  buildHeroCard(data) {
    const poolTempNum = parseNum(data.poolTemp);
    const tempScaleMin = 15;
    const tempScaleMax = 32;
    const tempPct = Number.isFinite(poolTempNum) ? Math.max(0, Math.min(100, ((poolTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100)) : 0;
    const targetTempNum = parseNum(data.targetTemp);
    const targetPct = Number.isFinite(targetTempNum) ? Math.max(0, Math.min(100, ((targetTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100)) : 0;

    const metric = (label, value, sub = '', badge = '', extraClass = '', trend = '→', ok = false) => `
      <div class="metric ${extraClass}">
        <div class="metric-label">${esc(label)}</div>
        <div class="metric-value">${esc(value)}${trend ? `<span class="trend ${trend === '↑' ? 'up' : trend === '↓' ? 'down' : 'flat'} ${ok ? 'ok' : ''}" style="margin-left:14px;font-weight:900;font-size:32px;line-height:1;vertical-align:middle;display:inline-block;min-width:28px;text-align:center;">${esc(trend)}</span>` : ''}</div>
        ${sub ? `<div class="metric-sub">${esc(sub)}</div>` : ''}
        ${badge || ''}
      </div>`;

    const orpBadge = data.orpInRange
      ? `<div class="metric-badge ok">OK</div>`
      : `<div class="metric-badge warn">${parseNum(data.orp) < parseNum(data.orpOnThreshold) ? 'Niedrig' : 'Hoch'}</div>`;

    const phBadge = data.phInRange
      ? `<div class="metric-badge ok">OK</div>`
      : `<div class="metric-badge warn">${parseNum(data.ph) < 7.1 ? 'Niedrig' : 'Hoch'}</div>`;

    return `
  <div class="card hero">
    <div class="titleRow">
      <div class="title">Pool Manager <span class="ver">${esc(data.adapterVersion)}</span></div>
      <div>
        <div class="mode">${data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL'}</div>
        <div class="updated">Aktualisiert<br>${esc(data.updated)}</div>
      </div>
    </div>
    <div class="tempWrap"><div class="tempVal">${esc(data.poolTemp)}</div><div class="tempUnit">°C</div></div>
    <div class="trackWrap">
      <div class="track"><div class="target"></div><div class="dot"></div></div>
      <div class="trackTarget">Aktuell: ${esc(data.poolTemp)} °C</div>
      <div class="trackLabels"><span>15 °C</span><span>32 °C</span></div>
    </div>
      <div class="metrics">
        ${metric('pH', data.ph, `Soll ${data.phSet}`, phBadge, 'warn', data.phTrend || '→', !!data.phInRange)}
        ${metric('ORP', data.orp, `Soll ${data.orpSet}`, orpBadge, 'warn', data.orpTrend || '→', !!data.orpInRange)}
        ${metric('Außen', `${data.outsideTemp}°C`, 'Außen', null, 'cool', data.outsideTempTrend || '→', false)}
        ${metric('Solltemp', `${data.targetTemp}°C`, 'Soll', null, 'metric-target')}
      </div>
    </div>
  </div>`;
  }

  buildTabletWidget(data) {
    const quick = (label, value, trend = '', barHtml = '') => `<div class="quick-card"><div class="quick-label">${esc(label)}</div><div class="quick-value-row"><div class="quick-value">${esc(value)}</div>${trend ? `<div class="quick-trend ${trend === '↑' ? 'up' : trend === '↓' ? 'down' : 'flat'}">${esc(trend)}</div>` : ''}</div>${barHtml || ''}</div>`;
    const autoBtn = (label, key, active) => `<button class="action-btn js-auto-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="action-name">${esc(label)}</span><span class="action-state">${active ? 'AKTIV' : 'AUS'}</span></button>`;
    const deviceBtn = (label, key, active) => `<button class="action-btn js-device-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="action-name">${esc(label)}</span><span class="action-state">${active ? 'EIN' : 'AUS'}</span></button>`;
    const batteryPct = Math.max(0, Math.min(100, parseNum(data.battery)));
    const batteryBar = `<div class="mini-bar"><div class="mini-fill battery-fill" style="width:${batteryPct}%"></div></div>`;
    return `<!-- widget-render:${esc(data.updated)} -->
<style>
.widget-wrap{width:100%;max-width:1180px;display:grid;grid-template-columns:280px 340px 1fr 150px;gap:8px;padding:8px;background:radial-gradient(circle at top left, rgba(89,188,255,.18), transparent 28%),#0a1323;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif}
.card{background:linear-gradient(180deg,#10203a 0%, #0a1323 100%);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:10px;box-shadow:0 10px 26px rgba(0,0,0,.35)}
.hero{grid-column:1/span 1;color:#fff}
.mid{grid-column:2/span 1;display:grid;gap:8px}
.right{grid-column:3/span 1;display:grid;gap:8px}
.side{grid-column:4/span 1;display:grid;gap:8px;color:#dbeafe}
.titleRow{display:flex;justify-content:space-between;align-items:flex-start}.title{font-size:20px;font-weight:800;color:#fff}.ver{font-size:11px;color:#b9d7ff;font-weight:700;margin-left:8px}.mode{font-size:14px;font-weight:800;padding:4px 10px;border-radius:999px;background:linear-gradient(180deg,#334f84,#1b3158);border:1px solid rgba(255,255,255,.12);display:inline-block;color:#fff}.updated{font-size:12px;color:#d2dded;text-align:right}
.tempWrap{display:flex;align-items:flex-end;gap:8px}.tempVal{font-size:68px;font-weight:900;line-height:.9;color:#fff}.tempUnit{font-size:20px;padding-bottom:10px;color:#dbeafe}
.trackWrap{margin-top:4px}.track{position:relative;height:10px;border-radius:999px;background:linear-gradient(90deg,#46b3ff 0%, #58d27a 55%, #f5c04f 78%, #ff7f6f 100%)}.target{position:absolute;top:50%;left:${Math.max(0,Math.min(100,((parseNum(data.targetTemp)-15)/(32-15))*100))}%;width:4px;height:18px;background:#fff;border:1px solid #1e3a5f;border-radius:999px;transform:translate(-50%,-50%)}.dot{position:absolute;top:50%;left:${Math.max(0,Math.min(100,((parseNum(data.poolTemp)-15)/(32-15))*100))}%;width:15px;height:15px;border-radius:50%;background:#dbeafe;border:4px solid #314a72;transform:translate(-50%,-50%)}.trackTarget{text-align:center;color:#d2dded;font-size:12px;margin-top:2px}.trackLabels{display:flex;justify-content:space-between;font-size:12px;color:#d2dded;margin-top:4px}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}.metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px}.metric-label{font-size:13px;color:#d9e5f5}.metric-value{font-size:18px;font-weight:900;color:#fff}.metric-sub{font-size:12px;color:#d9e5f5;margin-top:2px}.metric-badge{display:inline-flex;align-items:center;justify-content:center;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:800;margin-top:8px}.metric-badge.ok{background:rgba(93,212,111,.18);color:#90f3a3}.metric-badge.warn{background:rgba(255,176,103,.18);color:#ffd39e}
.section{font-size:13px;font-weight:800;color:#fff;margin-bottom:6px}.section.green{color:#a9f5b5}.section.orange{color:#ffd39e}
.list{display:grid;gap:6px}.status-item{background:linear-gradient(90deg,rgba(255,255,255,.06),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px;color:#fff}.status-item .name{font-size:12px;font-weight:700}.status-item .hint{font-size:10px;color:#cbd5e1;margin-top:2px}.status-item .state{font-size:14px;font-weight:900;margin-top:6px}.status-item.on .state{color:#6de27e}.status-item.off .state{color:#ff8d7b}.status-item.compact .status-line{display:flex;justify-content:space-between;gap:8px}.status-item.compact .state{margin-top:0}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.mini{background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px;color:#fff}.mini .label{font-size:11px;color:#d9e5f5}.mini .value{font-size:13px;font-weight:900;margin-top:4px;white-space:pre-line}
.toggle{display:flex;align-items:center;gap:8px;font-size:12px}.switch{position:relative;width:110px;height:34px;border-radius:999px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.1)}.switch.on{background:linear-gradient(90deg,#4ade80 0%, #22c55e 55%, rgba(255,255,255,.15) 55%, rgba(255,255,255,.15) 100%)}.switch::after{content:'';position:absolute;top:3px;left:3px;width:48px;height:26px;border-radius:999px;background:#e5e7eb;box-shadow:0 2px 8px rgba(0,0,0,.3);transition:left .2s ease}.switch.on::after{left:59px}
.buttonBar{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pill-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:14px 16px;border-radius:999px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);color:#fff;font-weight:800;border:1px solid rgba(255,255,255,.09);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28)}
.quick-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.quick-card{background:#fff;color:#0f172a;border-radius:14px;padding:10px;border:1px solid rgba(15,23,42,.08)}.quick-label{font-size:12px;color:#64748b;font-weight:700}.quick-value-row{display:flex;align-items:center;gap:8px}.quick-value{font-size:18px;font-weight:900;margin-top:4px}.quick-trend{font-size:18px;font-weight:900;line-height:1}.quick-trend.up{color:#ffb36b}.quick-trend.down{color:#52b7ff}.quick-trend.flat{color:#8fa3bc}.mini-bar{margin-top:6px;height:8px;border-radius:999px;background:linear-gradient(90deg,#ff6b6b 0%,#f59e0b 35%,#84cc16 65%,#22c55e 100%);position:relative;overflow:hidden}.mini-fill{height:100%;border-radius:999px}.battery-fill{background:linear-gradient(90deg,rgba(255,255,255,.28),rgba(255,255,255,.12));box-shadow:inset 0 0 0 999px rgba(255,255,255,.10)}
.action-btn{appearance:none;border:none;cursor:pointer;text-align:left;padding:12px 12px;border-radius:14px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;gap:3px}.action-name{font-size:16px;font-weight:800}.action-state{font-size:11px;font-weight:800}.action-btn.is-on .action-name,.action-btn.is-on .action-state{color:#67dd7c}.action-btn.is-off .action-name,.action-btn.is-off .action-state{color:#ff8d7b}
.manual-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:10px 12px;border-radius:999px;min-height:52px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}.manual-btn span{font-size:17px}.manual-btn small{font-size:12px;color:#dbeafe}
</style>
<div class="widget-wrap">
  ${this.buildHeroCard(data)}
    <div class="card">
      <div class="section green">Auto &amp; Wallbox</div>
      <div class="info-grid">
        ${quick('Status', data.wallboxChargingStatus)}
        ${quick('Stecker', data.wallboxPlugStatus)}
        ${quick('Leistung', `${data.wallboxPowerKw} kW`)}
        ${quick('SoC', `${data.wallboxSoc} % / ${data.wallboxTargetSoc} %`)}
        ${quick('Restzeit', data.wallboxTimeToFull)}
        ${quick('Reichweite', `${data.wallboxRangeKm} km`)}
      </div>
      <div class="footer-note">Stand: ${esc(data.wallboxTibberLastSeen || '--')}</div>
    </div>
  </div>
  <div class="mid">
    <div class="card"><div class="section">Energie & Steuerung</div><div class="list">
      ${this.statusItemHtml('Pumpe Auto', '', data.autoCirculationControl, true)}
      ${this.statusItemHtml('Chlor Auto', '', data.autoChlorControl, true)}
      ${this.statusItemHtml('pH Auto', '', data.autoPhControl, true)}
      ${this.statusItemHtml('WP Auto', '', data.autoHeatpumpControl, true)}
      <div class="status-item compact"><div class="status-line"><span class="name">PV-Leistung</span><span class="state" style="color:#fff">${esc(data.pv)} W</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Netzeinspeisung</span><span class="state" style="color:#fff">${esc(data.feedIn)} W</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Netzbezug</span><span class="state" style="color:#fff">${esc(data.gridSupply)} W</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Batterie SoC</span><span class="state" style="color:#fff">${esc(data.battery)} %</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">WP Freigabe</span><span class="state" style="color:#fff">${esc(data.heatDecision)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Chlor Freigabe</span><span class="state" style="color:#fff">${esc(data.chlorDecision)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Zeitplan</span><span class="state" style="color:#fff">${esc(data.pumpDecision)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">pH Prüfung</span><span class="state" style="color:#fff">${esc(data.phDecision)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">pH Zeiten</span><span class="state" style="color:#fff">${esc(data.phCheckTimes)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Standby nächster Lauf</span><span class="state" style="color:#fff">${esc(data.standbyNext)}</span></div></div>
      <div class="status-item compact"><div class="status-line"><span class="name">Letzte Dosierung</span><span class="state" style="color:#fff">${esc(data.phLastDoseDurationSec)} s</span></div></div>
    </div></div>
  </div>
  <div class="right">
    <div class="card"><div class="section green">Aktoren & Status</div><div class="list">
      ${this.statusItemHtml('Umwälzpumpe', 'IST-Zustand', data.pumpOn)}
      ${this.statusItemHtml('Chlorinator', 'ORP-Regelung', data.chlorOn)}
      ${this.statusItemHtml('pH-Dosierpumpe', 'Prüfzeiten', data.phPumpOn)}
      ${this.statusItemHtml('Wärmepumpe', 'PV-Freigabe', data.heatpumpOn)}
    </div></div>
    <div class="card"><div class="section orange">Zusatzwerte</div><div class="info-grid">
      <div class="mini"><div class="label">Zeitplan</div><div class="value">${esc(data.pumpDecision.includes('Zeitfenster aktiv') ? 'AKTIV' : (data.pumpDecision.includes('Standby') ? 'STANDBY' : (data.pumpDecision.includes('Steuerung deaktiviert') ? 'INAKTIV' : 'INAKTIV')))}</div></div>
      <div class="mini"><div class="label">PV Schwelle</div><div class="value">${esc(data.pvThreshold)} W</div></div>
      <div class="mini"><div class="label">ORP Grenzen</div><div class="value">${esc(data.orpOnThreshold)} / ${esc(data.orpOffThreshold)}</div></div>
      <div class="mini"><div class="label">pH Tag</div><div class="value">${esc(data.phDailyCount)}</div></div>
      <div class="mini"><div class="label">Pumpe ml/min</div><div class="value">${esc(data.phPumpFlowMlPerMin)}</div></div>
      <div class="mini"><div class="label">ml je 0,1 / 10m³</div><div class="value">${esc(data.phDoseMlPer01Per10m3)}</div></div>
      <div class="mini"><div class="label">Poolvolumen</div><div class="value">${esc(data.volume)} m³</div></div>
      <div class="mini"><div class="label">WP Lüfter</div><div class="value">${esc(data.heatpumpFanPercent)}</div></div>
      <div class="mini"><div class="label">WP Modus</div><div class="value">${esc(data.heatpumpMode)}</div></div>
      <div class="mini"><div class="label">Granulat manuell</div><div class="value">${esc(data.manualGranulateText)}</div></div>
    </div></div>
  </div>
  <div class="side">
    ${this.switchHtml('Standby', 'standby', data.standbyControl)}
    ${this.switchHtml('Auto Pumpe', 'circulation', data.autoCirculationControl, true)}
    ${this.switchHtml('Auto Chlor', 'chlor', data.autoChlorControl, true)}
    ${this.switchHtml('Auto PH', 'ph', data.autoPhControl, true)}
    ${this.switchHtml('Auto Wärmepumpe', 'heatpump', data.autoHeatpumpControl, true)}
  </div>
  <div class="card" style="grid-column:1 / span 4;"><div class="section orange">Manuelle Aktionen</div><div class="buttonBar">
    <button type="button" class="manual-btn js-manual-dose-btn" data-sec="${Number(data.phManualDoseSec || 30) || 30}"><span>PH Manuell</span><small>${esc(data.phManualDoseSec)} Sek.</small></button>
    <div class="buttonBar">
      <button type="button" class="pill-btn js-temp-btn" data-delta="-0.5">Solltemperatur -0,5°C</button>
      <button type="button" class="pill-btn js-temp-btn" data-delta="0.5">Solltemperatur +0,5°C</button>
    </div>
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
    const ok=await window.poolSetState(ns + '.control.ph.manualStart', true);
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
  const bind = () => {
    document.querySelectorAll('.js-auto-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolToggleControl(el.dataset.key, el.dataset.current==='1');return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
    document.querySelectorAll('.js-device-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolToggleState(el.dataset.key||'', el.dataset.current==='1');return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
    document.querySelectorAll('.js-standby-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolToggleStandby(el.dataset.current==='1');return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
    document.querySelectorAll('.js-manual-dose-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolPhManualDose(Number(el.dataset.sec||30));return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
    document.querySelectorAll('.js-temp-btn').forEach(el => {
      const fn=(ev)=>{try{if(ev){ev.preventDefault();ev.stopPropagation();}}catch(e){};window.poolAdjustSetTemp(Number(el.dataset.delta||0));return false;};
      el.onclick=fn; try{el.addEventListener('touchend', fn, {passive:false});}catch(e){}
    });
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', bind); else bind();
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
    const metricValue = (value, trend = '→', ok = false) => `<span class="ps-mmain ${ok ? 'ok' : ''}">${esc(value)}</span><span class="ps-trend ${trendClass(trend)} ${ok ? 'ok' : ''}" style="margin-left:10px;font-weight:900;font-size:18px;">${esc(trend)}</span>`;
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
.ps-metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:6px}.ps-ml{font-size:10px;color:#d9e5f5}.ps-mv{font-size:13px;font-weight:900;color:#fff;display:flex;align-items:center}.ps-ms{font-size:9px;color:#d9e5f5;margin-top:2px}.ps-badge{display:inline-flex;align-items:center;justify-content:center;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:800;margin-top:6px}.ps-badge.ok{background:rgba(93,212,111,.18);color:#90f3a3}.ps-badge.warn{background:rgba(255,176,103,.18);color:#ffd39e}
.ps-section{font-size:12px;font-weight:900;color:#0f172a;margin-bottom:3px}.ps-q{background:#f8fbff;border:1px solid #d7e1ee;border-radius:12px;padding:6px}.ps-ql{font-size:10px;color:#66758a;font-weight:700}.ps-qvr{display:flex;align-items:center;gap:8px}.ps-qv{font-size:13px;font-weight:900;color:#0f172a}.ps-qtrend{font-size:16px;font-weight:900;line-height:1;display:inline-flex;min-width:16px;justify-content:center}.ps-qtrend.up{color:#ffb36b}.ps-qtrend.down{color:#7dd3fc}.ps-qtrend.flat{color:#9aa8bc}.ps-bbar{margin-top:5px;height:7px;border-radius:999px;background:linear-gradient(90deg,#ff6b6b 0%, #f59e0b 45%, #58d27a 100%);overflow:hidden}.ps-bfill{height:100%;border-radius:999px;background:rgba(255,255,255,.35);box-shadow:inset 0 0 0 999px rgba(255,255,255,.18)}
.ps-btn{appearance:none;border:none;cursor:pointer;text-align:left;padding:7px 9px;border-radius:13px;min-height:44px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;gap:3px}.ps-btn-name{font-size:12px;font-weight:800}.ps-btn-state{font-size:9px;font-weight:800}.ps-btn.is-on .ps-btn-name,.ps-btn.is-on .ps-btn-state{color:#67dd7c}.ps-btn.is-off .ps-btn-name,.ps-btn.is-off .ps-btn-state{color:#ff8d7b}
.manual-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:7px 9px;border-radius:999px;min-height:44px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}.manual-btn span{font-size:13px}.manual-btn small{font-size:10px;color:#dbeafe}
.temp-btn{appearance:none;border:none;cursor:pointer;border-radius:12px;min-height:52px;padding:8px 10px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:16px}
.temp-center{display:flex;flex-direction:column;justify-content:center;align-items:center;background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:6px}.temp-center .quick-label{margin-bottom:2px}.temp-center .quick-value{font-size:16px}
</style>
</head><body><div class="ps-wrap">
  <div class="ps-card ps-hero">
    <div class="ps-header"><div class="ps-title">Pool Manager <span class="ps-ver">${esc(data.adapterVersion)}</span></div><div class="ps-sub"><div class="ps-mode">${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}</div><br>Aktualisiert<br>${esc(data.updated)}</div></div>
    <div class="ps-tempRow"><div class="ps-temp">${esc(data.poolTemp)}</div><div class="ps-unit">°C</div></div>
    <div class="ps-scale"><div class="ps-track"><div class="ps-target"></div><div class="ps-dot"></div></div><div class="ps-target-label"><span>Soll ${esc(data.targetTemp)}°C</span></div><div class="ps-scale-labels"><span>15 °C</span><span>32 °C</span></div></div>
    <div class="ps-metrics">
      <div class="ps-metric"><div class="ps-ml">pH</div><div class="ps-mv">${metricValue(data.ph, data.phTrend, data.phInRange)}</div></div>
      <div class="ps-metric"><div class="ps-ml">ORP</div><div class="ps-mv">${metricValue(data.orp, data.orpTrend, data.orpInRange)}</div></div>
      <div class="ps-metric"><div class="ps-ml">Außen</div><div class="ps-mv">${metricValue(`${data.outsideTemp}°C`, data.outsideTempTrend, false)}</div></div>
      <div class="ps-metric"><div class="ps-ml">Soll</div><div class="ps-mv">${esc(data.targetTemp)}°C</div></div>
    </div>
  </div>

  <div class="ps-card"><div class="ps-section">Schnellzugriff</div><div class="control-grid">
    <button type="button" class="action-btn js-standby-btn ${data.standbyControl ? 'is-on' : 'is-off'}" data-current="${data.standbyControl ? '1' : '0'}"><span class="action-name">Standby</span><span class="action-state">${data.standbyControl ? 'AKTIV' : 'AUS'}</span></button>
    <div class="temp-center"><div class="quick-label">Poolsolltemperatur</div><div class="quick-value">${esc(data.targetTemp)}°C</div></div>
    <button type="button" class="manual-btn js-manual-dose-btn" data-sec="${Number(data.phManualDoseSec || 30) || 30}" style="grid-column:1 / -1;"><span>PH Manuell</span><small>${esc(data.phManualDoseSec)} Sek.</small></button>
  </div></div>

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
    ${quick('WP Lüfter', String(data.heatpumpFanPercent ?? '--'))}
    ${quick('WP Modus', data.heatpumpMode || '--')}
    ${quick('Chlor Freigabe', data.chlorDecision)}
    ${quick('pH Prüfung', data.phDecision)}
  </div></div>

  <div class="ps-card"><div class="ps-section">pH Info</div><div class="ps-quickGrid ps-phGrid">
    ${quick('Berechnet', `${data.phCalculatedDoseSec} s / ${data.phCalculatedDoseMl} ml`)}
    ${quick('Letzte Dosis', `${data.phLastDoseDurationSec} s / ${data.phLastDoseMl} ml`)}
    ${quick('Heute dosiert', `${data.phDailyCount}x`)}
    ${quick('Nächste Prüfung', data.phNextCheck)}
    ${quick('Granulat manuell', data.manualGranulateText)}
    <button type="button" class="manual-btn js-manual-dose-btn" data-sec="${Number(data.phManualDoseSec || 30) || 30}"><span>PH Manuell</span><small>${esc(data.phManualDoseSec)} Sek.</small></button>
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
    const ok=await window.poolSetState(ns + '.control.ph.manualStart', true);
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
        handler(el);
        return false;
      };
      el.onclick = run;
      try{ el.addEventListener('touchend', run, {passive:false}); }catch(e){}
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
    const badge = txt => `<div style="display:inline-flex;align-items:center;justify-content:center;padding:4px 9px;border-radius:999px;background:rgba(255,255,255,.12);font-size:11px;font-weight:800;color:#fff;">${esc(txt)}</div>`;
    return this.buildTabletHtml(data)
      .replace('<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>', '<!-- widget-render:'+ esc(data.updated) +' --><style>')
      .replace('</head><body>', '')
      .replace('</body></html>', '');
  }

  async getHistoryPoints(stateId, startTs, endTs) {
    if (!stateId || !this.config.trendHistoryInstance) return [];
    const options = {
      id: stateId,
      options: {
        start: startTs,
        end: endTs,
        aggregate: 'none'
      }
    };
    return await new Promise(resolve => {
      try {
        this.sendTo(this.config.trendHistoryInstance, 'getHistory', options, result => {
          const rows = result && Array.isArray(result.result) ? result.result : [];
          resolve(rows);
        });
      } catch (e) {
        this.log.warn('History-Abfrage fehlgeschlagen für ' + stateId + ': ' + (e.message || e));
        resolve([]);
      }
    });
  }

  avgNumbers(rows) {
    const nums = (rows || []).map(r => Number(String(r && r.val).replace(',', '.'))).filter(Number.isFinite);
    if (!nums.length) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    return sum / nums.length;
  }

  trendArrow(delta, tolerance) {
    if (!Number.isFinite(delta)) return '→';
    if (Math.abs(delta) <= tolerance) return '→';
    return delta > 0 ? '↑' : '↓';
  }

  async getHistoryTrends() {
    const now = Date.now();
    if (this.trendCache.data && (now - (this.trendCache.ts || 0)) < 120000) {
      return this.trendCache.data;
    }

    const historyInstance = String(this.config.trendHistoryInstance || 'history.0').trim();
    if (!historyInstance) return {};

    const windowMin = Math.max(15, Number(this.config.trendWindowMin) || 60);
    const smoothMin = Math.max(1, Number(this.config.trendSmoothMin) || 5);
    const tolPh = Math.max(0.001, Number(String(this.config.trendTolerancePh || '0.03').replace(',', '.')) || 0.03);
    const tolOrp = Math.max(1, Number(this.config.trendToleranceOrp) || 15);
    const tolTemp = Math.max(0.01, Number(String(this.config.trendToleranceTemp || '0.3').replace(',', '.')) || 0.3);
    const tolPower = Math.max(10, Number(this.config.trendTolerancePowerW) || 50);

    const ranges = {
      nowStart: now - smoothMin * 60000,
      nowEnd: now,
      prevStart: now - windowMin * 60000,
      prevEnd: now - windowMin * 60000 + smoothMin * 60000,
    };

    const collectTrend = async (stateId, tolerance) => {
      if (!stateId) return '→';
      const [currRows, prevRows] = await Promise.all([
        this.getHistoryPoints(stateId, ranges.nowStart, ranges.nowEnd),
        this.getHistoryPoints(stateId, ranges.prevStart, ranges.prevEnd),
      ]);
      const curr = this.avgNumbers(currRows);
      const prev = this.avgNumbers(prevRows);
      if (!Number.isFinite(curr) || !Number.isFinite(prev)) return '→';
      return this.trendArrow(curr - prev, tolerance);
    };

    const originalHistoryInstance = this.config.trendHistoryInstance;
    this.config.trendHistoryInstance = historyInstance;
    const data = {
      phTrend: await collectTrend(this.config.phStateId, tolPh),
      orpTrend: await collectTrend(this.config.orpStateId, tolOrp),
      poolTempTrend: await collectTrend(this.config.poolTempStateId, tolTemp),
      outsideTempTrend: await collectTrend(this.config.outsideTempStateId, tolTemp),
      pvTrend: await collectTrend(this.config.pvPowerStateId, tolPower),
      feedInTrend: await collectTrend(this.config.gridFeedInStateId, tolPower),
    };
    this.config.trendHistoryInstance = originalHistoryInstance;
    this.trendCache = { ts: now, data };
    return data;
  }

  async onReady() {
    try {
      this.log.info('Poolsteuerung startet...');
      if (this.config.adapterEnabled === false) {
        this.log.warn('Adapter ist deaktiviert. Keine Steuerung wird ausgeführt.');
      }

      await this.ensureState('info.connection', 'boolean', 'indicator.connected', false, false);
      await this.ensureState('info.poolVolume', 'number', 'value.volume', 0, false);
      await this.ensureState('control.standby', 'boolean', 'switch.enable', this.config.standbyModeEnabled === true, true);
      await this.ensureState('control.auto.circulation', 'boolean', 'switch.enable', this.config.enableCirculationControl !== false, true);
      await this.ensureState('control.auto.chlor', 'boolean', 'switch.enable', this.config.enableChlorControl !== false, true);
      await this.ensureState('control.auto.ph', 'boolean', 'switch.enable', this.config.enablePhControl !== false, true);
      await this.ensureState('control.auto.heatpump', 'boolean', 'switch.enable', this.config.enableHeatpumpControl !== false, true);
      await this.ensureState('control.device.circulation', 'boolean', 'switch', false, true);
      await this.ensureState('control.device.chlorinator', 'boolean', 'switch', false, true);
      await this.ensureState('control.device.phPump', 'boolean', 'switch', false, true);
      await this.ensureState('control.device.heatpump', 'boolean', 'switch', false, true);
      await this.ensureState('control.heatpump.resetLock', 'boolean', 'button', false, true);
      await this.ensureState('control.ph.manualStart', 'boolean', 'button', false, true);
      await this.ensureState('control.ph.manualDoseSec', 'number', 'value.interval', parseNum(this.config.phDoseDurationSec || 30), true);
      await this.ensureState('control.heatpump.setTemp', 'number', 'level.temperature', 0, true);
      await this.ensureState('status.pump.lastRuntimeSec', 'number', 'value.interval', 0, false);
      await this.ensureState('status.pump.lastDecision', 'string', 'text', '--', false);
      await this.ensureState('status.heatpump.lastReason', 'string', 'text', '--', false);
      await this.ensureState('status.chlor.lastReason', 'string', 'text', '--', false);
      await this.ensureState('status.ph.lastReason', 'string', 'text', '--', false);
      await this.ensureState('status.ph.lastDoseDurationSec', 'number', 'value.interval', 0, false);
      await this.ensureState('status.ph.lastDoseTimestamp', 'number', 'value.time', 0, false);
      await this.ensureState('status.ph.dailyCount', 'number', 'value.counter', 0, false);
      await this.ensureState('status.ph.dailyDate', 'string', 'text', '', false);
      await this.ensureState('status.ph.lastDoseMl', 'number', 'value.volume', 0, false);
      await this.ensureState('status.ph.calculatedDoseSec', 'number', 'value.interval', 0, false);
      await this.ensureState('status.ph.calculatedDoseMl', 'number', 'value.volume', 0, false);
      await this.ensureState('status.ph.manualGranulateG', 'number', 'value.mass', 0, false);
      await this.ensureState('status.ph.stopAtTs', 'number', 'value.time', 0, false);
      await this.ensureState('status.debug.lastPumpScheduleActive', 'boolean', 'indicator', false, false);
      await this.ensureState('status.debug.lastPumpLoggedDecision', 'string', 'text', '', false);
      await this.ensureState('status.heartbeat.summary', 'string', 'text', 'ok', false);
      await this.ensureState('status.heartbeat.detailsJson', 'string', 'json', '{}', false);
      await this.ensureState('vis.htmlTablet', 'string', 'html', '', false);
      await this.ensureState('vis.htmlPhone', 'string', 'html', '', false);
      await this.ensureState('vis.widgetTablet', 'string', 'html', '', false);
      await this.ensureState('vis.widgetPhone', 'string', 'html', '', false);

      await this.updateComputedStates();
      await this.setStateAsync('info.connection', true, true);
      await this.resetManualBlockers('Adapterstart');
      this.clearPendingRenderTimeouts('Adapterstart');
      this.resetHeatpumpLocks('Adapterstart');
      await this.forceDependentDevicesOff('Adapterstart Recovery');
      await this.syncControlStates();
      await this.syncDeviceControlStates();
      await this.applyControlLogic();
      await this.logStartupSummary();
      await this.renderVis();
      this.timer = setInterval(async () => {
        try {
          await this.updateComputedStates();
          await this.applyControlLogic();
          await this.syncControlStates();
          await this.syncDeviceControlStates();
          await this.renderVis();
          await this.applyDependencyRules();
        } catch (e) {
          if (!this.isDbClosedError(e)) this.log.warn('Loop Fehler: ' + (e && e.stack ? e.stack : e));
        }
      }, Math.max(1, parseNum(this.config.pollIntervalMin || 1)) * 60000);
    } catch (e) {
      this.log.error('Startup Fehler: ' + (e && e.stack ? e.stack : e));
    }
  }

  async getControlBool(id, defaultVal = false) {
    try {
      const s = await this.getStateAsync(id);
      if (s && s.val !== null && s.val !== undefined) return !!s.val;
    } catch {}
    return !!defaultVal;
  }

  async syncControlStates() {
    await this.setStateIfChanged('control.standby', this.config.standbyModeEnabled === true, true);
    await this.setStateIfChanged('control.auto.circulation', this.config.enableCirculationControl !== false, true);
    await this.setStateIfChanged('control.auto.chlor', this.config.enableChlorControl !== false, true);
    await this.setStateIfChanged('control.auto.ph', this.config.enablePhControl !== false, true);
    await this.setStateIfChanged('control.auto.heatpump', this.config.enableHeatpumpControl !== false, true);
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
    if (!id) return false;
    const mode = String(
      id === this.config.circulationPumpSocketStateId ? (this.config.circulationPumpWriteMode || 'bool') :
      id === this.config.chlorinatorSocketStateId ? (this.config.chlorinatorWriteMode || 'bool') :
      id === this.config.phPumpSocketStateId ? (this.config.phPumpWriteMode || 'bool') : 'bool'
    );

    const zbTarget = this.getTasmotaZigbeeWriteTarget(id);
    if (zbTarget) {
      try {
        await this.setForeignStateAsync(zbTarget.cmdId, JSON.stringify({ Device: zbTarget.device, Send: { Power: on ? 1 : 0 } }), false);
        return true;
      } catch (e) {
        this.log.warn('Tasmota Zigbee Write fehlgeschlagen: ' + (e.message || e));
      }
    }

    const value = mode === 'num01' ? (on ? 1 : 0) : !!on;
    await this.setForeignStateAsync(id, value, false);
    return true;
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

  formatManualGranulateText(value) {
    const num = parseNum(value);
    if (!Number.isFinite(num) || num <= 0) return 'nicht nötig';
    const rounded = num >= 100 ? Math.round(num / 10) * 10 : Math.round(num);
    return `${rounded} g`;
  }

  async resetDailyPhCounterIfNeeded(now = new Date()) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dateState = await this.getStateAsync('status.ph.dailyDate');
    const countState = await this.getStateAsync('status.ph.dailyCount');
    const storedDate = dateState && dateState.val ? String(dateState.val) : '';
    if (storedDate !== today) {
      await this.setStateAsync('status.ph.dailyDate', today, true);
      await this.setStateAsync('status.ph.dailyCount', 0, true);
      return 0;
    }
    return Number(countState && countState.val) || 0;
  }

  async incrementTodayDoseCount(now = new Date()) {
    const current = await this.resetDailyPhCounterIfNeeded(now);
    const next = current + 1;
    await this.setStateAsync('status.ph.dailyCount', next, true);
    return next;
  }

  async syncPhStopState(now = Date.now()) {
    try {
      const stopState = await this.getStateAsync('status.ph.stopAtTs');
      const stopAt = Number(stopState && stopState.val) || 0;
      this.phDoseStopAtTsMemory = stopAt;
      if (stopAt > 0) {
        if (!this.phStopWatcher) {
          this.phStopWatcher = setInterval(async () => {
            try {
              if (!this.phDoseStopAtTsMemory) return;
              if (Date.now() < this.phDoseStopAtTsMemory) return;
              await this.stopDosePumpManaged('Timer abgelaufen');
            } catch (e) {
              if (!this.isDbClosedError(e)) this.log.warn('[PH] Stop-Überwachung fehlgeschlagen: ' + (e.message || e));
            }
          }, 1000);
        }
      } else if (this.phStopWatcher) {
        clearInterval(this.phStopWatcher);
        this.phStopWatcher = null;
      }
    } catch (e) {
      if (!this.isDbClosedError(e)) this.log.warn('[PH] syncPhStopState Fehler: ' + (e.message || e));
    }
  }

  async startDosePumpManaged(durationSec, info = {}) {
    if (!this.config.phPumpSocketStateId) return false;
    const pumpOn = await this.getBool(this.config.circulationPumpSocketStateId);
    if (!pumpOn) {
      this.log.warn('[PH] Dosierung blockiert: Umwälzpumpe nicht erreichbar');
      return false;
    }
    const sec = Math.max(1, Number(durationSec) || 0);
    const stopAtTs = Date.now() + sec * 1000;
    await this.forceSwitchOnCompat(this.config.phPumpSocketStateId);
    await this.setStateAsync('status.ph.stopAtTs', stopAtTs, true);
    this.phDoseStopAtTsMemory = stopAtTs;
    this.phManagedActive = true;
    await this.syncPhStopState();
    const doseMl = this.calcDoseMlFromSec(sec);
    await this.setStateAsync('status.ph.lastDoseDurationSec', sec, true);
    await this.setStateAsync('status.ph.lastDoseTimestamp', Date.now(), true);
    await this.setStateAsync('status.ph.lastDoseMl', doseMl, true);
    const title = info.manual ? 'Poolsteuerung pH-Dosierung gestartet' : 'Poolsteuerung pH-Dosierung gestartet';
    const text = info.manual
      ? `${title} | pH manuell | Laufzeit ${sec}s`
      : `${title} | pH ${info.phValue ?? '--'} | Laufzeit ${sec}s`;
    await this.sendAlert('ph_start', text);
    return true;
  }

  async stopDosePumpManaged(reason = '') {
    if (!this.config.phPumpSocketStateId) return false;
    try {
      await this.forceSwitchOffCompat(this.config.phPumpSocketStateId);
    } catch (e) {
      this.log.warn('[PH] Stop fehlgeschlagen: ' + (e.message || e));
    }
    await this.setStateAsync('status.ph.stopAtTs', 0, true);
    this.phDoseStopAtTsMemory = 0;
    this.phManagedActive = false;
    await this.syncPhStopState();
    if (reason) {
      await this.sendAlert('ph_stop', `Poolsteuerung pH-Dosierung beendet | ${reason}`);
    }
    return true;
  }

  calcDoseMlFromSec(sec) {
    const flow = Math.max(0, parseNum(this.config.phPumpFlowMlPerMin || 60));
    return Number(((flow / 60) * Math.max(0, Number(sec) || 0)).toFixed(1));
  }

  calcDoseSecFixed() {
    return Math.max(1, parseNum(this.config.phDoseDurationSec || 30));
  }

  calcDoseSecByDelta(phValue, volume) {
    const setpoint = parseNum(this.config.phSetpoint || 7.2);
    const tol = parseNum(this.config.phDoseTolerance || 0.05);
    const diff = Number(phValue) - setpoint;
    if (!Number.isFinite(diff) || diff <= tol) return 0;
    const per01 = Math.max(1, parseNum(this.config.phDoseSecondsPer01Per10m3 || 30));
    const maxSec = Math.max(1, parseNum(this.config.phDoseMaxDurationSec || 180));
    const sec = diff / 0.1 * (volume / 10) * per01;
    return Math.min(maxSec, Math.max(1, Math.round(sec)));
  }

  calcDoseMlByDelta(phValue, volume) {
    const setpoint = parseNum(this.config.phSetpoint || 7.2);
    const tol = parseNum(this.config.phDoseTolerance || 0.05);
    const diff = Number(phValue) - setpoint;
    if (!Number.isFinite(diff) || diff <= tol) return 0;
    const per01 = Math.max(1, parseNum(this.config.phDoseMlPer01Per10m3 || 100));
    const ml = diff / 0.1 * (volume / 10) * per01;
    return Math.max(0, Math.round(ml));
  }

  async computePhDoseValues(phValue) {
    const volume = this.calcVolume();
    const mode = String(this.config.phDoseMode || 'fixed');
    let durationSec = 0;
    let doseMl = 0;
    if (mode === 'ml') {
      doseMl = this.calcDoseMlByDelta(phValue, volume);
      durationSec = Math.max(0, Math.round((doseMl / Math.max(1, parseNum(this.config.phPumpFlowMlPerMin || 60))) * 60));
    } else if (mode === 'fixed') {
      const setpoint = parseNum(this.config.phSetpoint || 7.2);
      const tol = parseNum(this.config.phDoseTolerance || 0.05);
      durationSec = Number(phValue) - setpoint > tol ? this.calcDoseSecFixed() : 0;
      doseMl = this.calcDoseMlFromSec(durationSec);
    } else {
      durationSec = this.calcDoseSecByDelta(phValue, volume);
      doseMl = this.calcDoseMlByDelta(phValue, volume);
    }
    await this.setStateAsync('status.ph.calculatedDoseSec', durationSec, true);
    await this.setStateAsync('status.ph.calculatedDoseMl', doseMl, true);
    await this.setStateAsync('status.ph.manualGranulateG', Math.round(doseMl * 0.88), true);
    return { durationSec, doseMl, volume };
  }

  async runDosePumpOnce(durationSec, info = {}) {
    const started = await this.startDosePumpManaged(durationSec, info);
    if (!started) return false;
    return true;
  }

  async updatePhDecision(phValue, now = new Date()) {
    const enabled = await this.getControlBool('control.auto.ph', this.config.enablePhControl !== false);
    if (!enabled) {
      await this.setStateAsync('status.ph.lastReason', 'pH Freigabe AUS', true);
      return 'pH Freigabe AUS';
    }
    if (this.config.standbyModeEnabled === true || await this.getControlBool('control.standby', this.config.standbyModeEnabled === true)) {
      await this.setStateAsync('status.ph.lastReason', 'Standby aktiv', true);
      return 'Standby aktiv';
    }
    const dailyCount = await this.resetDailyPhCounterIfNeeded(now);
    const maxPerDay = Math.max(1, parseNum(this.config.phDoseMaxPerDay || 4));
    if (dailyCount >= maxPerDay) {
      const msg = `Poolsteuerung pH-Tageslimit erreicht (${dailyCount}/${maxPerDay})`;
      await this.setStateAsync('status.ph.lastReason', msg, true);
      await this.sendAlert('ph_limit', msg);
      return msg;
    }
    const inWindow = this.inPhCheckWindow(now);
    if (!inWindow) {
      const times = String(this.config.phCheckTimes || '').trim();
      const txt = times ? `warte auf Prüfzeit (${times})` : 'keine Prüfzeiten konfiguriert';
      await this.setStateAsync('status.ph.lastReason', txt, true);
      return txt;
    }
    const { durationSec, doseMl } = await this.computePhDoseValues(phValue);
    const setpoint = parseNum(this.config.phSetpoint || 7.2);
    const tol = parseNum(this.config.phDoseTolerance || 0.05);
    if (!Number.isFinite(phValue)) {
      const msg = 'pH-Wert ungültig';
      await this.setStateAsync('status.ph.lastReason', msg, true);
      await this.sendAlert('ph_invalid', `Poolsteuerung pH-Sensor ungültig`);
      return msg;
    }
    if (Number(phValue) <= setpoint + tol) {
      await this.setStateAsync('status.ph.lastReason', 'keine Dosierung nötig', true);
      await this.setStateAsync('status.ph.calculatedDoseSec', 0, true);
      await this.setStateAsync('status.ph.calculatedDoseMl', 0, true);
      return 'keine Dosierung nötig';
    }
    if (durationSec <= 0) {
      await this.setStateAsync('status.ph.lastReason', 'Berechnung ergab 0s', true);
      return 'Berechnung ergab 0s';
    }
    const ok = await this.runDosePumpOnce(durationSec, { phValue: Number(phValue).toFixed(2), doseMl });
    if (ok) {
      await this.incrementTodayDoseCount(now);
      const msg = `Dosierung gestartet ${durationSec}s / ${doseMl}ml`;
      await this.setStateAsync('status.ph.lastReason', msg, true);
      return msg;
    }
    const msg = 'Dosierung blockiert';
    await this.setStateAsync('status.ph.lastReason', msg, true);
    return msg;
  }

  async buildStableData() {
    const now = new Date();
    const poolTemp = this.fmt(await this.getNumber(this.config.poolTempStateId, 1), 1, '24.0');
    const ph = this.fmt(await this.getNumber(this.config.phStateId, 2), 2, '7.20');
    const orp = this.fmt(await this.getNumber(this.config.orpStateId, 0), 0, '730');
    const outsideTemp = this.fmt(await this.getNumber(this.config.outsideTempStateId, 1), 1, '--');
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
    const pumpDecision = await this.getText('poolsteuerung.0.status.debug.lastPumpDecision', '--');
    const chlorDecision = await this.getText('poolsteuerung.0.status.chlor.lastReason', '--');
    const phDecision = await this.getText('poolsteuerung.0.status.ph.lastReason', '--');
    const phCheckTimes = String(this.config.phCheckTimes || '').trim() || '--';
    const phDailyCount = Math.max(0, Number((await this.getStateAsync('status.ph.dailyCount'))?.val || 0));
    const phLastDoseDurationSec = Math.max(0, Number((await this.getStateAsync('status.ph.lastDoseDurationSec'))?.val || 0));
    const phLastDoseMl = Math.max(0, Number((await this.getStateAsync('status.ph.lastDoseMl'))?.val || 0));
    const phCalculatedDoseSec = Math.max(0, Number((await this.getStateAsync('status.ph.calculatedDoseSec'))?.val || 0));
    const phCalculatedDoseMl = Math.max(0, Number((await this.getStateAsync('status.ph.calculatedDoseMl'))?.val || 0));
    const manualGranulateText = this.formatManualGranulateText((await this.getStateAsync('status.ph.manualGranulateG'))?.val || 0);
    const phNextCheck = (() => {
      const next = this.getNextPhCheck(new Date());
      if (!next) return '--';
      return `${String(next.getDate()).padStart(2, '0')}.${String(next.getMonth() + 1).padStart(2, '0')}. ${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
    })();
    const updated = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}, ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const pumpState = await this.getStateSnapshot(this.config.circulationPumpSocketStateId);
    const chlorState = await this.getStateSnapshot(this.config.chlorinatorSocketStateId);
    const phPumpState = await this.getStateSnapshot(this.config.phPumpSocketStateId);
    const heatState = await this.getStateSnapshot(this.config.heatpumpPowerStateId);
    const pumpOn = !!(pumpState && pumpState.val);
    const chlorOn = !!(chlorState && chlorState.val);
    const phPumpOn = !!(phPumpState && phPumpState.val);
    const heatpumpOn = !!(heatState && heatState.val);

    const volume = this.fmt((await this.getStateAsync('info.poolVolume'))?.val || this.calcVolume(), 2, '0');
    const phSet = this.fmt(parseNum(this.config.phSetpoint || 7.2), 2, '7.20');
    const orpSet = this.fmt(parseNum(this.config.orpSetpoint || 730), 0, '730');
    const pvThreshold = this.fmt(parseNum(this.config.heatEnableFeedInThresholdW || 1000), 0, '1000');
    const orpOnThreshold = this.fmt(parseNum(this.config.orpOnThreshold || 725), 0, '725');
    const orpOffThreshold = this.fmt(parseNum(this.config.orpOffThreshold || 750), 0, '750');
    const phPumpFlowMlPerMin = this.fmt(parseNum(this.config.phPumpFlowMlPerMin || 60), 0, '60');
    const phDoseMlPer01Per10m3 = this.fmt(parseNum(this.config.phDoseMlPer01Per10m3 || 100), 0, '100');
    const heatpumpAuxIds = this.getDerivedHeatpumpAuxStateIds();
    const heatpumpFanPercent = await this.getText(heatpumpAuxIds.speedId, '--');
    const heatpumpMode = this.formatHeatpumpMode(await this.getText(heatpumpAuxIds.modeId, '--'));

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

    const stableData = {
      namespace: this.namespace,
      modeActive,
      poolTemp,
      ph,
      orp,
      outsideTemp,
      pv,
      feedIn,
      gridSupply,
      battery,
      targetTemp,
      updated,
      standbyNext: standbyNext ? this.formatDateTimeShort(standbyNext) : '-',
      standbyControl: standbyMode,
      autoCirculation,
      autoChlor,
      autoPh,
      autoHeatpump,
      autoCirculationControl: autoCirculationState,
      autoChlorControl: autoChlorState,
      autoPhControl: autoPhState,
      autoHeatpumpControl: autoHeatpumpState,
      pumpOn,
      chlorOn,
      phPumpOn,
      heatpumpOn,
      heatDecision: heatReason,
      chlorDecision,
      phDecision,
      phCheckTimes,
      phDailyCount,
      phLastDoseDurationSec,
      phLastDoseMl: this.fmt(phLastDoseMl, 0, '0'),
      phCalculatedDoseSec,
      phCalculatedDoseMl: this.fmt(phCalculatedDoseMl, 0, '0'),
      phNextCheck,
      manualGranulateText,
      volume,
      phSet,
      orpSet,
      pvThreshold,
      orpOnThreshold,
      orpOffThreshold,
      phPumpFlowMlPerMin,
      phDoseMlPer01Per10m3,
      heatpumpFanPercent,
      heatpumpMode,
      phTrend,
      orpTrend,
      poolTempTrend,
      outsideTempTrend,
      pvTrend,
      feedInTrend,
      phInRange,
      orpInRange,
      wallboxCharging,
      wallboxChargingStatus,
      wallboxPlugStatus,
      wallboxSoc,
      wallboxTargetSoc,
      wallboxRangeKm,
      wallboxPowerKw,
      wallboxTimeToFull,
      wallboxDatasetCreatedOn,
      wallboxTibberLastSeen,
      adapterVersion: 'v0.3.16hf13',
      phManualDoseSec: Math.max(1, Number((await this.getStateAsync('control.ph.manualDoseSec'))?.val || parseNum(this.config.phDoseDurationSec || 30))),
      heatpumpSetTempStateId: this.config.heatpumpSetTempStateId || ''
    };
    return stableData;
  }

  async renderVis() {
    if (this.isShuttingDown) return;
    const data = await this.buildStableData();
    const signature = JSON.stringify({
      poolTemp: data.poolTemp,
      ph: data.ph,
      orp: data.orp,
      outsideTemp: data.outsideTemp,
      pv: data.pv,
      feedIn: data.feedIn,
      gridSupply: data.gridSupply,
      battery: data.battery,
      targetTemp: data.targetTemp,
      modeActive: data.modeActive,
      pumpOn: data.pumpOn,
      chlorOn: data.chlorOn,
      phPumpOn: data.phPumpOn,
      heatpumpOn: data.heatpumpOn,
      autoCirculationControl: data.autoCirculationControl,
      autoChlorControl: data.autoChlorControl,
      autoPhControl: data.autoPhControl,
      autoHeatpumpControl: data.autoHeatpumpControl,
      heatDecision: data.heatDecision,
      chlorDecision: data.chlorDecision,
      phDecision: data.phDecision,
      phDailyCount: data.phDailyCount,
      phLastDoseDurationSec: data.phLastDoseDurationSec,
      phLastDoseMl: data.phLastDoseMl,
      phCalculatedDoseSec: data.phCalculatedDoseSec,
      phCalculatedDoseMl: data.phCalculatedDoseMl,
      phNextCheck: data.phNextCheck,
      manualGranulateText: data.manualGranulateText,
      heatpumpFanPercent: data.heatpumpFanPercent,
      heatpumpMode: data.heatpumpMode,
      wallboxChargingStatus: data.wallboxChargingStatus,
      wallboxPlugStatus: data.wallboxPlugStatus,
      wallboxSoc: data.wallboxSoc,
      wallboxTargetSoc: data.wallboxTargetSoc,
      wallboxRangeKm: data.wallboxRangeKm,
      wallboxPowerKw: data.wallboxPowerKw,
      wallboxTimeToFull: data.wallboxTimeToFull,
      wallboxTibberLastSeen: data.wallboxTibberLastSeen,
      phTrend: data.phTrend,
      orpTrend: data.orpTrend,
      poolTempTrend: data.poolTempTrend,
      outsideTempTrend: data.outsideTempTrend,
      pvTrend: data.pvTrend,
      feedInTrend: data.feedInTrend
    });

    const now = Date.now();
    const shouldSkip = signature === this.lastRenderSignature && now - this.lastRenderAt < 60000 && !this.renderQueued;
    if (shouldSkip) return;

    const tabletHtml = this.buildTabletHtml(data);
    const phoneHtml = this.buildPhoneHtml(data);
    const tabletWidget = this.buildTabletWidget(data);
    const phoneWidget = this.buildPhoneWidget(data);

    try {
      if (tabletHtml !== this.lastTabletHtml) {
        await this.setStateAsync('vis.htmlTablet', tabletHtml, true);
        this.lastTabletHtml = tabletHtml;
      }
      if (phoneHtml !== this.lastPhoneHtml) {
        await this.setStateAsync('vis.htmlPhone', phoneHtml, true);
        this.lastPhoneHtml = phoneHtml;
      }
      if (tabletWidget !== this.lastTabletWidget) {
        await this.setStateAsync('vis.widgetTablet', tabletWidget, true);
        this.lastTabletWidget = tabletWidget;
      }
      if (phoneWidget !== this.lastPhoneWidget) {
        await this.setStateAsync('vis.widgetPhone', phoneWidget, true);
        this.lastPhoneWidget = phoneWidget;
      }
      this.lastRenderSignature = signature;
      this.lastRenderAt = now;
    } catch (e) {
      if (!this.isDbClosedError(e)) this.log.warn('VIS Render Fehler: ' + (e && e.stack ? e.stack : e));
    }
  }

  queueDelayedRefresh(delayMs = 1200) {
    if (this.isShuttingDown) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    const handle = this.trackTimeout(setTimeout(async () => {
      this.pendingTimeouts.delete(handle);
      this.renderQueued = false;
      try {
        this.lastRenderSignature = '';
        this.lastRenderAt = 0;
        await this.renderVis();
      } catch (e) {
        if (!this.isDbClosedError(e)) this.log.warn('VIS Delayed Refresh Fehler: ' + (e && e.stack ? e.stack : e));
      }
    }, Math.max(250, Number(delayMs) || 1200)));
  }

  buildPhoneHtml(data) {
    const poolTempNum = parseNum(data.poolTemp);
    const tempScaleMin = 15;
    const tempScaleMax = 32;
    const tempPct = Number.isFinite(poolTempNum) ? Math.max(0, Math.min(100, ((poolTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100)) : 0;
    const targetTempNum = parseNum(data.targetTemp);
    const targetPct = Number.isFinite(targetTempNum) ? Math.max(0, Math.min(100, ((targetTempNum - tempScaleMin) / (tempScaleMax - tempScaleMin)) * 100)) : 0;

    const quick = (label, value, trend = '', barHtml = '') => `<div class="quick-card"><div class="quick-label">${esc(label)}</div><div class="quick-value-row"><div class="quick-value">${esc(value)}</div>${trend ? `<div class="quick-trend ${trend === '↑' ? 'up' : trend === '↓' ? 'down' : 'flat'}">${esc(trend)}</div>` : ''}</div>${barHtml || ''}</div>`;
    const autoBtn = (label, key, active) => `<button class="action-btn js-auto-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="action-name">${esc(label)}</span><span class="action-state">${active ? 'AKTIV' : 'AUS'}</span></button>`;
    const deviceBtn = (label, key, active) => `<button class="action-btn js-device-btn ${active ? 'is-on' : 'is-off'}" data-key="${esc(key)}" data-current="${active ? '1' : '0'}"><span class="action-name">${esc(label)}</span><span class="action-state">${active ? 'EIN' : 'AUS'}</span></button>`;
    const batteryPct = Math.max(0, Math.min(100, parseNum(data.battery)));
    const batteryBar = `<div class="mini-bar"><div class="mini-fill battery-fill" style="width:${batteryPct}%"></div></div>`;

    return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>
html,body{margin:0;padding:0;background:radial-gradient(circle at top left, rgba(89,188,255,.18), transparent 28%),#0a1323;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif}
.wrap{max-width:510px;margin:0 auto;padding:6px;display:grid;gap:8px}.card{background:linear-gradient(180deg,#ffffff 0%,#eef5ff 100%);border:1px solid rgba(15,23,42,.08);border-radius:18px;padding:10px;box-shadow:0 8px 20px rgba(0,0,0,.18)}.hero{background:radial-gradient(circle at top right, rgba(85,200,255,.26), transparent 26%),linear-gradient(180deg,#1b3763 0%,#0f2343 100%);color:#fff;border-color:rgba(255,255,255,.10)}
.header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.title{font-size:20px;font-weight:900}.ver{font-size:11px;font-weight:800;color:#b9d7ff;margin-left:8px}.meta{font-size:11px;color:#d2dded;text-align:right}.mode-badge{display:inline-flex;align-items:center;justify-content:center;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:linear-gradient(180deg,#334f84,#1b3158);font-weight:800;font-size:11px;color:#fff;cursor:pointer}
.temp-row{display:flex;align-items:flex-end;gap:6px;margin:6px 0 8px}.temp{font-size:72px;font-weight:900;line-height:.9}.unit{font-size:22px;padding-bottom:10px;color:#d5e5f6}
.scale{margin:4px 0 8px}.track{position:relative;height:10px;border-radius:999px;background:linear-gradient(90deg,#46b3ff 0%, #58d27a 55%, #f5c04f 78%, #ff7f6f 100%)}.target-mark{position:absolute;top:50%;left:${targetPct}%;width:4px;height:18px;border-radius:999px;background:#fff;border:1px solid rgba(17,48,91,.8);transform:translate(-50%,-50%)}.dot{position:absolute;top:50%;left:${tempPct}%;width:16px;height:16px;border-radius:50%;background:#fff;border:4px solid #314a72;transform:translate(-50%,-50%)}.scale-labels{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:#e3edf9}.target-label{position:relative;height:16px;font-size:12px;color:#d2dded}.target-label span{position:absolute;left:${targetPct}%;transform:translateX(-50%)}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:10px}.metric-label{font-size:13px;color:#d9e5f5}.metric-value{font-size:18px;font-weight:900;color:#fff;display:flex;align-items:center}.metric-sub{font-size:12px;color:#d9e5f5;margin-top:2px}.metric-badge{display:inline-flex;align-items:center;justify-content:center;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:800;margin-top:8px}.metric-badge.ok{background:rgba(93,212,111,.18);color:#90f3a3}.metric-badge.warn{background:rgba(255,176,103,.18);color:#ffd39e}
.quick-grid,.auto-grid,.status-grid,.control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
.ph-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.metric{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:6px}.metric-label{font-size:10px;color:#d9e5f5}.metric-value{font-size:13px;font-weight:900;color:#fff}
.section-title{font-size:12px;font-weight:900;color:#0f172a;margin-bottom:3px}
.quick-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:6px}.quick-label{font-size:9px;color:#64748b;font-weight:700;margin-bottom:3px}.quick-value-row{display:flex;align-items:center;gap:8px}.quick-value{font-size:12px;font-weight:900;color:#0f172a;line-height:1.08}.quick-trend{font-size:18px;font-weight:900;line-height:1}.quick-trend.up{color:#ffb36b}.quick-trend.down{color:#52b7ff}.quick-trend.flat{color:#8fa3bc}.mini-bar{margin-top:6px;height:8px;border-radius:999px;background:linear-gradient(90deg,#ff6b6b 0%,#f59e0b 35%,#84cc16 65%,#22c55e 100%);position:relative;overflow:hidden}.mini-fill{height:100%;border-radius:999px}.battery-fill{background:linear-gradient(90deg,rgba(255,255,255,.28),rgba(255,255,255,.12));box-shadow:inset 0 0 0 999px rgba(255,255,255,.10)}
.action-btn{appearance:none;border:none;cursor:pointer;text-align:left;padding:7px 9px;border-radius:13px;min-height:44px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;gap:3px}
.action-name{font-size:12px;font-weight:800}.action-state{font-size:9px;font-weight:800}
.action-btn.is-on .action-name,.action-btn.is-on .action-state{color:#67dd7c}
.action-btn.is-off .action-name,.action-btn.is-off .action-state{color:#ff8d7b}
.manual-btn{appearance:none;border:none;cursor:pointer;text-align:center;padding:7px 9px;border-radius:999px;min-height:44px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-weight:800}.manual-btn span{font-size:13px}.manual-btn small{font-size:10px;color:#dbeafe}
.temp-btn{appearance:none;border:none;cursor:pointer;border-radius:12px;min-height:52px;padding:8px 10px;background:linear-gradient(180deg,#2d4f86 0%,#162d52 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 8px 18px rgba(6,24,44,.28);border:1px solid rgba(255,255,255,.09);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:16px}
.temp-center{display:flex;flex-direction:column;justify-content:center;align-items:center;background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:6px}.temp-center .quick-label{margin-bottom:2px}.temp-center .quick-value{font-size:16px}
</style>
</head><body><div class="wrap">
  <div class="card hero">
    <div class="header"><div class="title">Pool Manager <span class="ver">${esc(data.adapterVersion)}</span></div><div class="meta"><div class="mode-badge">${esc(data.modeActive === 'standby' ? 'STANDBY' : 'NORMAL')}</div><br>Aktualisiert<br>${esc(data.updated)}</div></div>
    <div class="temp-row"><div class="temp">${esc(data.poolTemp)}</div><div class="unit">°C</div></div>
    <div class="scale"><div class="track"><div class="target-mark"></div><div class="dot"></div></div><div class="target-label"><span>Soll ${esc(data.targetTemp)}°C</span></div><div class="scale-labels"><span>15 °C</span><span>32 °C</span></div></div>
    <div class="metrics">
      <div class="metric"><div class="metric-label">pH</div><div class="metric-value">${metricValue(data.ph, data.phTrend, data.phInRange)}</div></div>
      <div class="metric"><div class="metric-label">ORP</div><div class="metric-value">${metricValue(data.orp, data.orpTrend, data.orpInRange)}</div></div>
      <div class="metric"><div class="metric-label">Außen</div><div class="metric-value">${metricValue(`${data.outsideTemp}°C`, data.outsideTempTrend, false)}</div></div>
      <div class="metric"><div class="metric-label">Soll</div><div class="metric-value">${esc(data.targetTemp)}°C</div></div>
    </div>
  </div>

  <div class="card"><div class="section-title">Schnellzugriff</div><div class="control-grid">
    <button type="button" class="action-btn js-standby-btn ${data.standbyControl ? 'is-on' : 'is-off'}" data-current="${data.standbyControl ? '1' : '0'}"><span class="action-name">Standby</span><span class="action-state">${data.standbyControl ? 'AKTIV' : 'AUS'}</span></button>
    <div class="temp-center"><div class="quick-label">Poolsolltemperatur</div><div class="quick-value">${esc(data.targetTemp)}°C</div></div>
    <button type="button" class="manual-btn js-manual-dose-btn" data-sec="${Number(data.phManualDoseSec || 30) || 30}" style="grid-column:1 / -1;"><span>PH Manuell</span><small>${esc(data.phManualDoseSec)} Sek.</small></button>
  </div></div>

  <div class="card"><div class="section-title">Automatik</div><div class="auto-grid">
    ${autoBtn('Umwälzpumpe','circulation',!!data.autoCirculationControl)}
    ${autoBtn('Chlor','chlor',!!data.autoChlorControl)}
    ${autoBtn('pH','ph',!!data.autoPhControl)}
    ${autoBtn('Wärmepumpe','heatpump',!!data.autoHeatpumpControl)}
  </div></div>

  <div class="card"><div class="section-title">Aktoren & Status</div><div class="status-grid">
    ${deviceBtn('Umwälzpumpe','circulation',!!data.pumpOn)}
    ${deviceBtn('Chlorinator','chlorinator',!!data.chlorOn)}
    ${deviceBtn('pH-Dosierpumpe','phPump',!!data.phPumpOn)}
    ${deviceBtn('Wärmepumpe','heatpump',!!data.heatpumpOn)}
  </div></div>

  <div class="card"><div class="section-title">Energie & Steuerung</div><div class="quick-grid">
    ${quick('PV-Leistung', `${data.pv} W`, data.pvTrend || '→')}
    ${quick('Einspeisung', `${data.feedIn} W`, data.feedInTrend || '→')}
    ${quick('Batterie', `${data.battery} %`, '', batteryBar)}
    ${quick('WP Freigabe', data.heatDecision)}
    ${quick('WP Lüfter', String(data.heatpumpFanPercent ?? '--'))}
    ${quick('WP Modus', data.heatpumpMode || '--')}
    ${quick('Chlor Freigabe', data.chlorDecision)}
    ${quick('pH Prüfung', data.phDecision)}
  </div></div>

  <div class="ps-card"><div class="ps-section">pH Info</div><div class="ps-quickGrid ps-phGrid">
    ${quick('Berechnet', `${data.phCalculatedDoseSec} s / ${data.phCalculatedDoseMl} ml`)}
    ${quick('Letzte Dosis', `${data.phLastDoseDurationSec} s / ${data.phLastDoseMl} ml`)}
    ${quick('Heute dosiert', `${data.phDailyCount}x`)}
    ${quick('Nächste Prüfung', data.phNextCheck)}
    ${quick('Granulat manuell', data.manualGranulateText)}
    <button type="button" class="manual-btn js-manual-dose-btn" data-sec="${Number(data.phManualDoseSec || 30) || 30}"><span>PH Manuell</span><small>${esc(data.phManualDoseSec)} Sek.</small></button>
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
    const ok=await window.poolSetState(ns + '.control.ph.manualStart', true);
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
        handler(el);
        return false;
      };
      el.onclick = run;
      try{ el.addEventListener('touchend', run, {passive:false}); }catch(e){}
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

  async applyControlLogic() {
    const now = new Date();

    const standbyMode = await this.getControlBool('control.standby', this.config.standbyModeEnabled === true);
    const circulationEnabled = await this.getControlBool('control.auto.circulation', this.config.enableCirculationControl !== false);
    const chlorEnabled = await this.getControlBool('control.auto.chlor', this.config.enableChlorControl !== false);
    const phEnabled = await this.getControlBool('control.auto.ph', this.config.enablePhControl !== false);
    const heatEnabledMaster = await this.getControlBool('control.auto.heatpump', this.config.enableHeatpumpControl !== false);

    const pumpId = this.config.circulationPumpSocketStateId;
    const chlorId = this.config.chlorinatorSocketStateId;
    const phPumpId = this.config.phPumpSocketStateId;
    const heatpumpId = this.config.heatpumpPowerStateId;

    const pumpScheduleActive = this.isWithinCirculationSchedule(now);
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
      if (this.config.simulateMode) {
        pumpDecision = 'würde AUS (Auto außerhalb Zeitfenster, Simulationsmodus)';
      } else if (pumpId) {
        try {
          await this.forceSwitchOffCompat(pumpId);
          this.suppressOwnPumpLogUntil = Date.now() + 5000;
          pumpDecision = 'AUS außerhalb Zeitfenster';
        } catch (e) {
          pumpDecision = `Schaltfehler: ${e.message || e}`;
        }
      }
    } else {
      pumpDecision = standbyMode
        ? (pumpTarget ? `Standby-Kurzlauf aktiv (${this.getStandbyDurationSec()}s)` : 'Standby aktiv')
        : (!circulationEnabled
            ? (pumpCurrent ? 'Manuell EIN (Steuerung deaktiviert)' : 'Steuerung deaktiviert')
            : (pumpTarget ? `Zeitfenster aktiv (${this.getCirculationScheduleLabel(now)})` : `Außerhalb Zeitfenster (${this.getCirculationScheduleLabel(now)})`));
    }

    this.lastPumpScheduleActiveMemory = pumpTarget;
    await this.setStateAsync('status.debug.lastPumpScheduleActive', pumpTarget, true);
    if (!this.isControlTransitionActive() && Date.now() >= this.suppressOwnPumpLogUntil) {
      const lastLogged = (await this.getStateAsync('status.debug.lastPumpLoggedDecision'))?.val || '';
      if (String(lastLogged) !== String(pumpDecision)) {
        await this.setStateAsync('status.debug.lastPumpLoggedDecision', pumpDecision, true);
      }
    }
    await this.setStateAsync('status.pump.lastRuntimeSec', this.getPumpOnForSec(nowMs), true);
    await this.setStateAsync('status.pump.lastDecision', pumpDecision, true);

    const pumpOn = this.config.circulationPumpSocketStateId ? await this.getBool(this.config.circulationPumpSocketStateId) : pumpCurrent;
    const circulationHeartbeat = await this.evaluateHeartbeat('Umwälzpumpe', this.config.circulationPumpHeartbeatStateId, this.config.circulationPumpHeartbeatMaxAgeMin);
    const chlorHeartbeat = await this.evaluateHeartbeat('Chlorinator', this.config.chlorinatorHeartbeatStateId, this.config.chlorinatorHeartbeatMaxAgeMin);
    const phHeartbeat = await this.evaluateHeartbeat('pH-Dosierpumpe', this.config.phPumpHeartbeatStateId, this.config.phPumpHeartbeatMaxAgeMin);
    const heatHeartbeat = await this.evaluateHeartbeat('Wärmepumpe', this.config.heatpumpHeartbeatStateId, this.config.heatpumpHeartbeatMaxAgeMin);

    const circulationHeartbeatOkDisplay = this.config.circulationPumpHeartbeatStateId && Number(this.config.circulationPumpHeartbeatMaxAgeMin) > 0 ? circulationHeartbeat.ok : pumpOn;

    const orp = await this.getNumber(this.config.orpStateId);
    const ph = await this.getNumber(this.config.phStateId);
    const poolTemp = await this.getNumber(this.config.poolTempStateId);
    const outsideTemp = await this.getNumber(this.config.outsideTempStateId);
    const feedIn = await this.getNumber(this.config.gridFeedInStateId);
    const threshold = parseNum(this.config.heatEnableFeedInThresholdW || 1000);
    const orpOnThreshold = parseNum(this.config.orpOnThreshold || 725);
    const orpOffThreshold = parseNum(this.config.orpOffThreshold || 750);
    const targetTemp = this.config.heatpumpSetTempStateId
      ? ((await this.getNumber(this.config.heatpumpSetTempStateId)) ?? parseNum(this.config.heatpumpTargetTemp))
      : parseNum(this.config.heatpumpTargetTemp);

    let chlorDesired = this.config.chlorinatorSocketStateId ? await this.getBool(this.config.chlorinatorSocketStateId) : false;
    let chlorDecision = 'Steuerung deaktiviert';
    const chlorDelaySec = Math.max(0, parseNum(this.config.chlorPumpStartDelaySec || 0));
    const pumpOnForSec = this.getPumpOnForSec(nowMs);
    const chlorDelayActive = chlorDelaySec > 0 && pumpOn && pumpOnForSec < chlorDelaySec;
    const chlorCurrent = chlorDesired;

    if (!chlorEnabled) {
      chlorDesired = pumpOn ? chlorCurrent : false;
      chlorDecision = pumpOn
        ? (chlorCurrent ? 'Manuell EIN (Auto AUS)' : 'Steuerung deaktiviert · manuell AUS')
        : (chlorCurrent ? 'Sicherheits-AUS: Umwälzpumpe AUS' : 'Steuerung deaktiviert · Pumpe AUS');
    } else if (!pumpOn) {
      chlorDesired = false;
      chlorDecision = 'Pumpe AUS';
    } else if (chlorDelayActive) {
      chlorDesired = false;
      chlorDecision = `Verzögert nach Pumpenstart (${Math.max(0, chlorDelaySec - pumpOnForSec)}s Rest)`;
    } else if (!chlorHeartbeat.ok && this.config.chlorinatorHeartbeatStateId && Number(this.config.chlorinatorHeartbeatMaxAgeMin) > 0) {
      chlorDesired = false;
      chlorDecision = 'Gerät nicht erreichbar';
    } else if (!Number.isFinite(orp)) {
      chlorDesired = false;
      chlorDecision = 'ORP ungültig';
    } else {
      if (chlorCurrent) {
        chlorDesired = orp <= orpOffThreshold;
        chlorDecision = chlorDesired ? `Hysterese (${orp} <= ${orpOffThreshold})` : `ORP hoch (${orp} > ${orpOffThreshold})`;
      } else {
        chlorDesired = orp <= orpOnThreshold;
        chlorDecision = chlorDesired ? `ORP niedrig (${orp} <= ${orpOnThreshold})` : `Hysterese (${orp} > ${orpOnThreshold})`;
      }
    }

    if (this.config.chlorinatorSocketStateId && chlorDesired !== chlorCurrent) {
      try {
        await (chlorDesired ? this.forceSwitchOnCompat(this.config.chlorinatorSocketStateId) : this.forceSwitchOffCompat(this.config.chlorinatorSocketStateId));
      } catch (e) {
        this.log.warn('Chlorinator konnte nicht gesetzt werden: ' + e);
      }
    }
    await this.setStateAsync('status.chlor.lastReason', chlorDecision, true);

    const phDecision = await this.updatePhDecision(ph, now);

    const heatpumpOnRaw = this.config.heatpumpPowerStateId ? await this.getBool(this.config.heatpumpPowerStateId) : false;
    const heatLock = this.getHeatpumpLockState();
    let heatDecision = 'Steuerung deaktiviert';
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
      namespace: this.namespace,
      modeActive: standbyMode ? 'standby' : 'normal',
      poolTemp: this.fmt(poolTemp, 1, '24.0'),
      ph: this.fmt(ph, 2, '7.20'),
      orp: this.fmt(orp, 0, '730'),
      outsideTemp: this.fmt(outsideTemp, 1, '--'),
      pv: this.fmt(await this.getNumber(this.config.pvPowerStateId, 0), 0, '0'),
      feedIn: this.fmt(feedIn, 0, '0'),
      gridSupply: this.fmt(await this.getNumber(this.config.gridSupplyStateId, 0), 0, '0'),
      battery: this.fmt(await this.getNumber(this.config.batterySocStateId, 0), 0, '0'),
      targetTemp: this.fmt(targetTemp, 1, '24.0'),
      updated: `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}, ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      standbyNext: standbyMode ? this.formatDateTimeShort(this.getNextStandbyRun(now)) : '-',
      standbyControl: standbyMode,
      autoCirculationControl: circulationEnabled,
      autoChlorControl: chlorEnabled,
      autoPhControl: phEnabled,
      autoHeatpumpControl: heatEnabledMaster,
      pumpOn,
      chlorOn: chlorDesired,
      phPumpOn: this.config.phPumpSocketStateId ? await this.getBool(this.config.phPumpSocketStateId) : false,
      heatpumpOn,
      heatDecision,
      chlorDecision,
      phDecision,
      phCheckTimes: String(this.config.phCheckTimes || '').trim() || '--',
      phDailyCount: Math.max(0, Number((await this.getStateAsync('status.ph.dailyCount'))?.val || 0)),
      phLastDoseDurationSec: Math.max(0, Number((await this.getStateAsync('status.ph.lastDoseDurationSec'))?.val || 0)),
      phLastDoseMl: this.fmt(Math.max(0, Number((await this.getStateAsync('status.ph.lastDoseMl'))?.val || 0)), 0, '0'),
      phCalculatedDoseSec: Math.max(0, Number((await this.getStateAsync('status.ph.calculatedDoseSec'))?.val || 0)),
      phCalculatedDoseMl: this.fmt(Math.max(0, Number((await this.getStateAsync('status.ph.calculatedDoseMl'))?.val || 0)), 0, '0'),
      phNextCheck: (() => { const next = this.getNextPhCheck(now); return next ? `${String(next.getDate()).padStart(2, '0')}.${String(next.getMonth() + 1).padStart(2, '0')}. ${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}` : '--'; })(),
      manualGranulateText: this.formatManualGranulateText((await this.getStateAsync('status.ph.manualGranulateG'))?.val || 0),
      volume: this.fmt((await this.getStateAsync('info.poolVolume'))?.val || this.calcVolume(), 2, '0'),
      phSet: this.fmt(parseNum(this.config.phSetpoint || 7.2), 2, '7.20'),
      orpSet: this.fmt(parseNum(this.config.orpSetpoint || 730), 0, '730'),
      pvThreshold: this.fmt(parseNum(this.config.heatEnableFeedInThresholdW || 1000), 0, '1000'),
      orpOnThreshold: this.fmt(parseNum(this.config.orpOnThreshold || 725), 0, '725'),
      orpOffThreshold: this.fmt(parseNum(this.config.orpOffThreshold || 750), 0, '750'),
      phPumpFlowMlPerMin: this.fmt(parseNum(this.config.phPumpFlowMlPerMin || 60), 0, '60'),
      phDoseMlPer01Per10m3: this.fmt(parseNum(this.config.phDoseMlPer01Per10m3 || 100), 0, '100'),
      heatpumpFanPercent,
      heatpumpMode,
      phTrend,
      orpTrend,
      poolTempTrend,
      outsideTempTrend,
      pvTrend,
      feedInTrend,
      phInRange,
      orpInRange,
      wallboxCharging: false,
      wallboxChargingStatus: 'GETRENNT',
      wallboxPlugStatus: 'unknown',
      wallboxSoc: '--',
      wallboxTargetSoc: '--',
      wallboxRangeKm: '--',
      wallboxPowerKw: '--',
      wallboxTimeToFull: '--',
      wallboxDatasetCreatedOn: '--',
      wallboxTibberLastSeen: '--',
      adapterVersion: 'v0.3.16hf13',
      phManualDoseSec: Math.max(1, Number((await this.getStateAsync('control.ph.manualDoseSec'))?.val || parseNum(this.config.phDoseDurationSec || 30))),
      heatpumpSetTempStateId: this.config.heatpumpSetTempStateId || ''
    };

    if (this.config.wallboxChargingStatusStateId || this.config.wallboxPlugStatusStateId || this.config.wallboxSocStateId || this.config.wallboxPowerKwStateId) {
      const wbChargingStatusRaw = await this.getText(this.config.wallboxChargingStatusStateId, '--');
      const wbPlugStatusRaw = await this.getText(this.config.wallboxPlugStatusStateId, '--');
      const wbSocNum = await this.getNumber(this.config.wallboxSocStateId, NaN);
      const wbTargetSocNum = await this.getNumber(this.config.wallboxTargetSocStateId, NaN);
      const wbTimeFullNum = await this.getNumber(this.config.wallboxTimeToFullStateId, NaN);
      const wbRangeKmNum = await this.getNumber(this.config.wallboxRangeKmStateId, NaN);
      const wbPowerKwNum = await this.getNumber(this.config.wallboxPowerKwStateId, NaN);
      const wbChargingRawText = String(wbChargingStatusRaw || '').trim().toLowerCase();
      const wbPlugRawText = String(wbPlugStatusRaw || '').trim().toLowerCase();
      const wbIsConnected = ['connected', 'verbunden'].includes(wbPlugRawText);
      const wbPowerForStatus = (wbIsConnected && Number.isFinite(wbPowerKwNum) && wbPowerKwNum >= 0.3) ? wbPowerKwNum : 0;
      const wbCharging = ['charging','laden','lädt','charge_state_charging_hv_battery'].includes(wbChargingRawText) || wbPowerForStatus >= 0.3;
      stableData.wallboxCharging = wbCharging;
      stableData.wallboxChargingStatus = wbIsConnected ? (wbCharging ? 'LÄDT' : (wbChargingRawText === 'idle' ? 'BEREIT' : String(wbChargingStatusRaw || '--'))) : 'GETRENNT';
      stableData.wallboxPlugStatus = wbIsConnected ? 'Verbunden' : (wbPlugRawText === 'disconnected' ? 'Getrennt' : String(wbPlugStatusRaw || '--'));
      stableData.wallboxSoc = this.fmt(wbSocNum, 0, '--');
      stableData.wallboxTargetSoc = this.fmt(wbTargetSocNum, 0, '--');
      stableData.wallboxRangeKm = this.fmt(wbRangeKmNum, 0, '--');
      stableData.wallboxPowerKw = this.fmt(wbPowerForStatus, 1, '--');
      stableData.wallboxTimeToFull = wbCharging ? this.formatDurationHours(wbTimeFullNum, '--') : '--';
      stableData.wallboxTibberLastSeen = await this.getFormattedDateTimeFromState('vw-connect.0.WVGZZZE23TE055069.statustibber.rawData.status.lastSeen', '--');
    }

    await this.setStateAsync('status.heatpump.lastReason', heatDecision, true);
    return stableData;
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

  isPumpScheduleActive(now = new Date()) {
    return this.isWithinCirculationSchedule(now);
  }

  async onStateChange(id, state) {
    if (!state || this.isShuttingDown) return;
    try {
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

      const standbyActiveNow = await this.getControlBool('control.standby', this.config.standbyModeEnabled === true);
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

      if (id === `${this.namespace}.control.ph.manualStart` && !!state.val === true) {
        this.beginControlTransition(3500);
        const manualSecState = await this.getStateAsync('control.ph.manualDoseSec');
        const manualSec = Math.max(1, Number(manualSecState && manualSecState.val) || 30);
        const ok = await this.runDosePumpOnce(manualSec, { checkTime: 'MANUELL', phValue: 'manuell', manual: true });
        if (ok) {
          await this.incrementTodayDoseCount(new Date());
        }
        await this.setStateIfChanged('control.ph.manualStart', false, false);
        await this.applyControlLogic();
        await this.forceImmediateRender();
        this.queueDelayedRefresh(1200);
        return;
      }

      if (id === `${this.namespace}.control.heatpump.setTemp` && state.ack === false) {
        this.beginControlTransition(3500);
        const val = Number(String(state.val).replace(',', '.'));
        if (Number.isFinite(val) && this.config.heatpumpSetTempStateId) {
          try {
            await this.setForeignStateAsync(this.config.heatpumpSetTempStateId, val, false);
          } catch (e) {
            this.log.warn('Wärmepumpen-Solltemperatur konnte nicht gesetzt werden: ' + (e.message || e));
          }
        }
        await this.forceImmediateRender();
        this.queueDelayedRefresh(1500);
        return;
      }

      const ownDeviceIds = [
        `${this.namespace}.control.device.circulation`,
        `${this.namespace}.control.device.chlorinator`,
        `${this.namespace}.control.device.phPump`,
        `${this.namespace}.control.device.heatpump`
      ];
      if (ownDeviceIds.includes(id) && state.ack === false) {
        this.beginControlTransition(3500);
        const key = id.split('.').slice(-1)[0];
        if (!!state.val === true) {
          if (standbyActiveNow) {
            await this.setStateIfChanged('control.standby', false, false);
          }
          if (key === 'circulation') await this.setStateIfChanged('control.auto.circulation', false, false);
          if (key === 'chlorinator') await this.setStateIfChanged('control.auto.chlor', false, false);
          if (key === 'phPump') await this.setStateIfChanged('control.auto.ph', false, false);
          if (key === 'heatpump') await this.setStateIfChanged('control.auto.heatpump', false, false);
        }
        let realId = '';
        if (key === 'circulation') realId = this.config.circulationPumpSocketStateId;
        if (key === 'chlorinator') realId = this.config.chlorinatorSocketStateId;
        if (key === 'phPump') realId = this.config.phPumpSocketStateId;
        if (key === 'heatpump') realId = this.config.heatpumpPowerStateId;
        if (realId) {
          try {
            await (state.val ? this.forceSwitchOnCompat(realId) : this.forceSwitchOffCompat(realId));
          } catch (e) {
            this.log.warn('Aktor manuell schalten fehlgeschlagen: ' + (e.message || e));
          }
        }
        await this.forceImmediateRender();
        this.queueDelayedRefresh(1500);
        return;
      }

      if (id === this.config.circulationPumpSocketStateId || id === this.config.chlorinatorSocketStateId || id === this.config.phPumpSocketStateId || id === this.config.heatpumpPowerStateId) {
        await this.syncDeviceControlStates();
        if (id === this.config.circulationPumpSocketStateId) {
          const on = !!state.val;
          this.updateCirculationPumpRuntime(on, state.lc || state.ts);
          if (Date.now() >= this.suppressOwnPumpLogUntil) {
            const currentDecision = (await this.getStateAsync('status.debug.lastPumpLoggedDecision'))?.val || '';
            const txt = `[PUMPE] Realzustand ${on ? 'EIN' : 'AUS'} | ${currentDecision || 'ohne Entscheidungs-Text'}`;
            this.log.info(txt);
          }
        }
        await this.applyControlLogic();
        await this.forceImmediateRender();
        this.queueDelayedRefresh(1500);
      }
    } catch (e) {
      if (!this.isDbClosedError(e)) this.log.warn('Control-State konnte nicht angewendet werden: ' + (e && e.stack ? e.stack : e));
    }
  }

  onUnload(callback) {
    try {
      this.isShuttingDown = true;
      if (this.timer) clearInterval(this.timer);
      if (this.phStopWatcher) clearInterval(this.phStopWatcher);
      this.clearPendingRenderTimeouts('Unload');
      this.resetHeatpumpLocks('Unload');
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

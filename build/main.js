'use strict';
const utils = require('@iobroker/adapter-core');
class Poolsteuerung extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'poolsteuerung' });
    this.timer = null;
    this.phRunning = false;
    this.lastDoseKeys = {};
    this.lastChlorSwitch = 0;
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
  }
  debug(msg) { if (this.config.debugMode) this.log.info('[DEBUG] ' + msg); }
  async mk(id, type, role, def, write) {
    await this.setObjectNotExistsAsync(id, { type:'state', common:{ name:id, type, role, read:true, write, def }, native:{} });
    if (!write) await this.setStateAsync(id, def, true);
  }
  async onReady() {
    await this.mk('info.connection', 'boolean', 'indicator.connected', false, false);
    await this.mk('status.overall.message', 'string', 'text', '', false);
    await this.mk('status.ph.previewMl', 'number', 'value', 0, false);
    await this.mk('status.ph.previewRuntimeSec', 'number', 'value', 0, false);
    await this.mk('status.ph.lastAction', 'string', 'text', '', false);
    await this.mk('status.chlorinator.lastAction', 'string', 'text', '', false);
    await this.mk('status.pump.lastAction', 'string', 'text', '', false);
    await this.mk('status.debug.lastCycle', 'string', 'text', '', false);
    await this.mk('status.debug.lastDecision', 'string', 'text', '', false);
    await this.mk('control.manualDose', 'boolean', 'button', false, true);
    await this.setStateAsync('info.connection', true, true);
    this.subscribeStates('control.manualDose');
    if (this.config.phStateId) this.subscribeForeignStates(this.config.phStateId);
    if (this.config.orpStateId) this.subscribeForeignStates(this.config.orpStateId);
    this.debug('Adapter gestartet');
    this.debug('simulateMode=' + !!this.config.simulateMode);
    this.debug('LiquidFactor=' + this.config.phLiquidFactorPercent + '%');
    this.debug('MaxDoseMlPerCycle=' + this.config.phMaxDoseMlPerCycle);
    this.timer = setInterval(() => this.loop(), Math.max(1, Number(this.config.pollIntervalMin) || 1) * 60000);
    setTimeout(() => this.loop(), 1000);
  }
  async onUnload(callback) {
    try { if (this.timer) clearInterval(this.timer); await this.setStateAsync('info.connection', false, true); callback(); } catch { callback(); }
  }
  async onStateChange(id, state) {
    if (!state) return;
    if (id === `${this.namespace}.control.manualDose` && state.val === true && !state.ack) {
      this.debug('Manuelle Dosierung angefordert');
      await this.phDose('Manuell');
      await this.setStateAsync('control.manualDose', false, true);
    }
  }
  async getForeignNumber(id) {
    if (!id) return null;
    try { const s = await this.getForeignStateAsync(id); const n = Number(s && s.val); return isNaN(n) ? null : n; } catch { return null; }
  }
  async getForeignBoolean(id, fallback) {
    if (!id) return fallback;
    try { const s = await this.getForeignStateAsync(id); return s ? !!s.val : fallback; } catch { return fallback; }
  }
  async setActorState(id, val, context) {
    if (!id) return;
    if (this.config.simulateMode) {
      this.debug(`${context}: SIMULATION ${id} -> ${val}`);
      await this.setStateAsync('status.debug.lastDecision', `${context}: simulate ${id}=${val}`, true);
      return;
    }
    this.debug(`${context}: schalte ${id} -> ${val}`);
    await this.setForeignStateAsync(id, val);
    await this.setStateAsync('status.debug.lastDecision', `${context}: ${id}=${val}`, true);
  }
  hhmm() { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
  parseTimes(csv) { return String(csv || '').split(',').map(x => x.trim()).filter(Boolean); }
  calcPoolVolumeL() {
    const configured = Number(this.config.poolVolumeM3) || 0;
    if (configured > 0) return configured * 1000;
    return Math.PI * Math.pow((Number(this.config.poolDiameterM) || 0) / 2, 2) * (Number(this.config.poolWaterHeightM) || 0) * 1000;
  }
  calcPhDose(ph) {
    const delta = Number(ph) - (Number(this.config.phTarget) || 7.2);
    if (isNaN(delta) || delta <= Number(this.config.phMinDelta || 0)) return { rawMl: 0, limitedMl: 0, sec: 0, delta };
    const base = Math.max(0, delta * 10 * Math.max(0, this.calcPoolVolumeL() / 100));
    const rawMl = Math.round(base * ((Number(this.config.phLiquidFactorPercent) || 100) / 100));
    const limitedMl = Math.min(rawMl, Number(this.config.phMaxDoseMlPerCycle) || rawMl);
    const sec = Math.min(Number(this.config.phMaxRuntimeSec) || 300, Math.round((limitedMl / Math.max(0.1, Number(this.config.phPumpFlowMlMin) || 16)) * 60));
    return { rawMl, limitedMl, sec, delta };
  }
  async phPreview() {
    const ph = await this.getForeignNumber(this.config.phStateId);
    if (ph === null) { this.debug('pH Vorschau: kein pH-Wert'); return; }
    const r = this.calcPhDose(ph);
    this.debug(`pH Berechnung -> ph=${ph} delta=${r.delta} rawMl=${r.rawMl} limitedMl=${r.limitedMl} sec=${r.sec}`);
    await this.setStateAsync('status.ph.previewMl', r.limitedMl, true);
    await this.setStateAsync('status.ph.previewRuntimeSec', r.sec, true);
  }
  async phDose(reason) {
    const ph = await this.getForeignNumber(this.config.phStateId);
    if (ph === null) { this.debug('pH blockiert: kein pH-Wert'); return; }
    const rel = await this.getForeignBoolean(this.config.phDoseEnableStateId, true);
    if (!rel) { this.debug('pH blockiert: Freigabe false'); return; }
    const pump = await this.getForeignBoolean(this.config.circulationPumpSocketStateId, false);
    if (!pump && this.config.phOnlyWhenPumpRunning) { this.debug('pH blockiert: Pumpe aus'); return; }
    const r = this.calcPhDose(ph);
    if (r.limitedMl <= 0 || r.sec <= 0) { this.debug('pH nicht nötig'); return; }
    if (r.rawMl > r.limitedMl) this.debug(`pH Dosis begrenzt -> rawMl=${r.rawMl} limitedMl=${r.limitedMl}`);
    this.phRunning = true;
    this.debug(`pH START -> reason=${reason} delta=${r.delta} rawMl=${r.rawMl} limitedMl=${r.limitedMl} sec=${r.sec}`);
    await this.setActorState(this.config.phPumpSocketStateId, true, 'pH START');
    await this.setStateAsync('status.ph.lastAction', `${reason}: gestartet (${r.limitedMl} ml)`, true);
    setTimeout(async () => {
      await this.setActorState(this.config.phPumpSocketStateId, false, 'pH ENDE');
      this.phRunning = false;
      this.debug(`pH ENDE -> reason=${reason}`);
      await this.setStateAsync('status.ph.lastAction', `${reason}: beendet`, true);
    }, r.sec * 1000);
  }
  async phTick() {
    if (!this.config.phEnabled || this.phRunning) { this.debug(`pH Tick übersprungen -> enabled=${this.config.phEnabled} running=${this.phRunning}`); return; }
    const now = this.hhmm();
    for (const t of this.parseTimes(this.config.phDoseTimes)) {
      if (t === now && !this.lastDoseKeys[t]) { this.lastDoseKeys[t] = Date.now(); this.debug(`pH Automatik bei ${t}`); await this.phDose('Automatik ' + t); }
    }
  }
  async chlorTick() {
    if (!this.config.chlorinatorEnabled || !this.config.chlorinatorAutoEnabled) { this.debug('Chlorinator Tick übersprungen'); return; }
    const orp = await this.getForeignNumber(this.config.orpStateId);
    if (orp === null) { this.debug('Chlorinator blockiert: kein ORP'); return; }
    const state = await this.getForeignBoolean(this.config.chlorinatorSocketStateId, false);
    const pump = await this.getForeignBoolean(this.config.circulationPumpSocketStateId, false);
    this.debug(`Chlorinator Check -> ORP=${orp} state=${state} pump=${pump}`);
    if (this.config.chlorinatorOnlyWhenPumpRunning && !pump) {
      this.debug('Chlorinator blockiert: Pumpe aus');
      if (state) await this.setActorState(this.config.chlorinatorSocketStateId, false, 'Chlorinator AUS wegen Pumpe');
      return;
    }
    const now = Date.now();
    const minOn = (Number(this.config.chlorinatorMinOnMin) || 0) * 60000;
    const minOff = (Number(this.config.chlorinatorMinOffMin) || 0) * 60000;
    if (state && orp >= Number(this.config.orpOff || 780) && now - this.lastChlorSwitch >= minOn) {
      this.debug(`Chlorinator AUS bei ORP ${orp}`);
      await this.setActorState(this.config.chlorinatorSocketStateId, false, 'Chlorinator AUS');
      this.lastChlorSwitch = now;
      await this.setStateAsync('status.chlorinator.lastAction', `AUS bei ORP ${orp}`, true);
    } else if (!state && orp <= Number(this.config.orpOn || 720) && now - this.lastChlorSwitch >= minOff) {
      this.debug(`Chlorinator EIN bei ORP ${orp}`);
      await this.setActorState(this.config.chlorinatorSocketStateId, true, 'Chlorinator EIN');
      this.lastChlorSwitch = now;
      await this.setStateAsync('status.chlorinator.lastAction', `EIN bei ORP ${orp}`, true);
    } else {
      this.debug('Chlorinator keine Änderung');
    }
  }
  async pumpTick() {
    if (!this.config.pumpEnabled) { this.debug('Pumpenlogik deaktiviert'); return; }
    const now = this.hhmm();
    const start = this.config.pumpStartTime || '';
    const end = this.config.pumpEndTime || '';
    if (!start || !end) { this.debug('Pumpenlogik blockiert: Zeitfenster fehlt'); return; }
    const shouldRun = now >= start && now < end;
    const state = await this.getForeignBoolean(this.config.circulationPumpSocketStateId, false);
    this.debug(`Pumpenfenster ${start}-${end} | jetzt=${now} | shouldRun=${shouldRun} | state=${state}`);
    if (shouldRun && !state) {
      await this.setActorState(this.config.circulationPumpSocketStateId, true, 'Pumpe EIN');
      await this.setStateAsync('status.pump.lastAction', `Pumpe EIN ${now}`, true);
    }
    if (!shouldRun && state) {
      await this.setActorState(this.config.circulationPumpSocketStateId, false, 'Pumpe AUS');
      await this.setStateAsync('status.pump.lastAction', `Pumpe AUS ${now}`, true);
    }
  }
  async loop() {
    await this.setStateAsync('status.debug.lastCycle', new Date().toISOString(), true);
    this.debug('----- Zyklus -----');
    const ph = await this.getForeignNumber(this.config.phStateId);
    const orp = await this.getForeignNumber(this.config.orpStateId);
    const pump = await this.getForeignBoolean(this.config.circulationPumpSocketStateId, false);
    this.debug(`Sensoren -> pH=${ph} ORP=${orp} Pumpe=${pump}`);
    await this.pumpTick();
    await this.phPreview();
    await this.phTick();
    await this.chlorTick();
  }
}
if (require.main !== module) {
  module.exports = options => new Poolsteuerung(options);
} else {
  (() => new Poolsteuerung())();
}

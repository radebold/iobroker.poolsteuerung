'use strict';
const utils = require('@iobroker/adapter-core');
class Poolsteuerung extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'poolsteuerung' });
    this.timer = null;
    this.phRunning = false;
    this.lastDoseKeys = {};
    this.lastChlorSwitch = 0;
    this.lastHeatpumpSwitch = 0;
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
    await this.mk('status.ph.previewMl', 'number', 'value', 0, false);
    await this.mk('status.ph.previewRuntimeSec', 'number', 'value', 0, false);
    await this.mk('status.ph.lastAction', 'string', 'text', '', false);
    await this.mk('status.chlorinator.lastAction', 'string', 'text', '', false);
    await this.mk('status.pump.lastAction', 'string', 'text', '', false);
    await this.mk('status.heatpump.lastAction', 'string', 'text', '', false);
    await this.mk('status.heatpump.lastReason', 'string', 'text', '', false);
    await this.mk('status.heatpump.waterTemp', 'number', 'value.temperature', 0, false);
    await this.mk('status.heatpump.energySource', 'string', 'text', '', false);
    await this.mk('status.debug.lastCycle', 'string', 'text', '', false);
    await this.mk('control.manualDose', 'boolean', 'button', false, true);
    await this.setStateAsync('info.connection', true, true);
    this.subscribeStates('control.manualDose');
    this.timer = setInterval(() => this.loop(), Math.max(1, Number(this.config.pollIntervalMin) || 1) * 60000);
    setTimeout(() => this.loop(), 1000);
  }
  async onUnload(callback) { try { if (this.timer) clearInterval(this.timer); await this.setStateAsync('info.connection', false, true); callback(); } catch { callback(); } }
  async onStateChange(id, state) { if (!state) return; if (id === `${this.namespace}.control.manualDose` && state.val === true && !state.ack) { await this.phDose('Manuell'); await this.setStateAsync('control.manualDose', false, true); } }
  async getForeignNumber(id) { if (!id) return null; try { const s = await this.getForeignStateAsync(id); const n = Number(s && s.val); return isNaN(n) ? null : n; } catch { return null; } }
  async getForeignBoolean(id, fallback) { if (!id) return fallback; try { const s = await this.getForeignStateAsync(id); return s ? !!s.val : fallback; } catch { return fallback; } }
  async setActorState(id, val) { if (!id) return; if (this.config.simulateMode) return; await this.setForeignStateAsync(id, val); }
  async setForeignValue(id, val) { if (!id) return; if (this.config.simulateMode) return; await this.setForeignStateAsync(id, val); }
  hhmm() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  parseTimes(csv) { return String(csv || '').split(',').map(x => x.trim()).filter(Boolean); }
  calcPoolVolumeL() { const configured = Number(this.config.poolVolumeM3) || 0; if (configured > 0) return configured * 1000; return Math.PI * Math.pow((Number(this.config.poolDiameterM) || 0) / 2, 2) * (Number(this.config.poolWaterHeightM) || 0) * 1000; }
  calcPhDose(ph) { const delta = Number(ph) - (Number(this.config.phTarget) || 7.2); if (isNaN(delta) || delta <= Number(this.config.phMinDelta || 0)) return { limitedMl: 0, sec: 0 }; const base = Math.max(0, delta * 10 * Math.max(0, this.calcPoolVolumeL() / 100)); const rawMl = Math.round(base * ((Number(this.config.phLiquidFactorPercent) || 100) / 100)); const limitedMl = Math.min(rawMl, Number(this.config.phMaxDoseMlPerCycle) || rawMl); const sec = Math.min(Number(this.config.phMaxRuntimeSec) || 300, Math.round((limitedMl / Math.max(0.1, Number(this.config.phPumpFlowMlMin) || 16)) * 60)); return { limitedMl, sec }; }
  async phPreview() { const ph = await this.getForeignNumber(this.config.phStateId); if (ph === null) return; const r = this.calcPhDose(ph); await this.setStateAsync('status.ph.previewMl', r.limitedMl, true); await this.setStateAsync('status.ph.previewRuntimeSec', r.sec, true); }
  async phDose(reason) { const ph = await this.getForeignNumber(this.config.phStateId); if (ph === null) return; const rel = await this.getForeignBoolean(this.config.phDoseEnableStateId, true); if (!rel) return; const pump = await this.getForeignBoolean(this.config.circulationPumpSocketStateId, false); if (!pump && this.config.phOnlyWhenPumpRunning) return; const r = this.calcPhDose(ph); if (r.limitedMl <= 0 || r.sec <= 0) return; this.phRunning = true; await this.setActorState(this.config.phPumpSocketStateId, true); await this.setStateAsync('status.ph.lastAction', `${reason}: gestartet (${r.limitedMl} ml)`, true); setTimeout(async () => { await this.setActorState(this.config.phPumpSocketStateId, false); this.phRunning = false; await this.setStateAsync('status.ph.lastAction', `${reason}: beendet`, true); }, r.sec * 1000); }
  async phTick() { if (!this.config.phEnabled || this.phRunning) return; const now = this.hhmm(); for (const t of this.parseTimes(this.config.phDoseTimes)) { if (t === now && !this.lastDoseKeys[t]) { this.lastDoseKeys[t] = Date.now(); await this.phDose('Automatik ' + t); } } }
  async chlorTick() { if (!this.config.chlorinatorEnabled || !this.config.chlorinatorAutoEnabled) return; const orp = await this.getForeignNumber(this.config.orpStateId); if (orp === null) return; const state = await this.getForeignBoolean(this.config.chlorinatorSocketStateId, false); const pump = await this.getForeignBoolean(this.config.circulationPumpSocketStateId, false); if (this.config.chlorinatorOnlyWhenPumpRunning && !pump) { if (state) await this.setActorState(this.config.chlorinatorSocketStateId, false); return; } const now = Date.now(); const minOn = (Number(this.config.chlorinatorMinOnMin) || 0) * 60000; const minOff = (Number(this.config.chlorinatorMinOffMin) || 0) * 60000; if (state && orp >= Number(this.config.orpOff || 780) && now - this.lastChlorSwitch >= minOn) { await this.setActorState(this.config.chlorinatorSocketStateId, false); this.lastChlorSwitch = now; await this.setStateAsync('status.chlorinator.lastAction', `AUS bei ORP ${orp}`, true); } else if (!state && orp <= Number(this.config.orpOn || 720) && now - this.lastChlorSwitch >= minOff) { await this.setActorState(this.config.chlorinatorSocketStateId, true); this.lastChlorSwitch = now; await this.setStateAsync('status.chlorinator.lastAction', `EIN bei ORP ${orp}`, true); } }
  async pumpTick() { if (!this.config.pumpEnabled) return; const now = this.hhmm(); const start = this.config.pumpStartTime || ''; const end = this.config.pumpEndTime || ''; if (!start || !end) return; const shouldRun = now >= start && now < end; const state = await this.getForeignBoolean(this.config.circulationPumpSocketStateId, false); if (shouldRun && !state) { await this.setActorState(this.config.circulationPumpSocketStateId, true); await this.setStateAsync('status.pump.lastAction', `Pumpe EIN ${now}`, true); } if (!shouldRun && state) { await this.setActorState(this.config.circulationPumpSocketStateId, false); await this.setStateAsync('status.pump.lastAction', `Pumpe AUS ${now}`, true); } }
  async heatpumpOff(reason) { const powerState = await this.getForeignBoolean(this.config.heatpumpPowerStateId, false); if (!powerState) { await this.setStateAsync('status.heatpump.lastReason', reason, true); return; } await this.setActorState(this.config.heatpumpPowerStateId, false); this.lastHeatpumpSwitch = Date.now(); await this.setStateAsync('status.heatpump.lastAction', 'AUS', true); await this.setStateAsync('status.heatpump.lastReason', reason, true); }
  async heatpumpTick() { if (!this.config.heatpumpEnabled) return; const waterTemp = await this.getForeignNumber(this.config.waterTempStateId); const feedIn = await this.getForeignNumber(this.config.gridFeedInStateId); const batterySoc = await this.getForeignNumber(this.config.batterySocStateId); const pump = await this.getForeignBoolean(this.config.circulationPumpSocketStateId, false); const powerState = await this.getForeignBoolean(this.config.heatpumpPowerStateId, false); await this.setStateAsync('status.heatpump.waterTemp', waterTemp === null ? 0 : waterTemp, true); if (waterTemp === null) { await this.heatpumpOff('Keine Wassertemperatur'); return; } if (waterTemp < Number(this.config.heatpumpMinWaterTemp || 0)) { await this.heatpumpOff('Wassertemperatur unter Mindestwert'); return; } if (this.config.heatpumpOnlyWhenPumpRunning && !pump) { await this.heatpumpOff('Umwälzpumpe aus'); return; } const target = Number(this.config.heatpumpTargetTemp || 24); const tempNeedsHeat = waterTemp < target; const batteryFull = batterySoc !== null && batterySoc >= Number(this.config.heatpumpBatteryFullSoc || 98); const byPv = feedIn !== null && feedIn >= Number(this.config.heatpumpPvMinFeedInW || 1500); const bySoc = batterySoc !== null && batterySoc >= Number(this.config.heatpumpMinBatterySoc || 95); let energyAllowed = false; let energySource = ''; if (this.config.heatpumpRequiresBatteryFull && batteryFull) { energyAllowed = true; energySource = 'batteryFull'; } else if (byPv) { energyAllowed = true; energySource = 'pvFeedIn'; } else if (bySoc) { energyAllowed = true; energySource = 'batterySoc'; } await this.setStateAsync('status.heatpump.energySource', energySource, true); const now = Date.now(); const minOn = (Number(this.config.heatpumpMinOnMin) || 0) * 60000; const minOff = (Number(this.config.heatpumpMinOffMin) || 0) * 60000; if (!tempNeedsHeat) { if (powerState && now - this.lastHeatpumpSwitch < minOn) return; await this.heatpumpOff('Zieltemperatur erreicht'); return; } if (!energyAllowed) { if (powerState && now - this.lastHeatpumpSwitch < minOn) return; await this.heatpumpOff('Keine Energie-Freigabe'); return; } if (!powerState && now - this.lastHeatpumpSwitch < minOff) return; if (!powerState) { await this.setForeignValue(this.config.heatpumpModeStateId, 1); await this.setForeignValue(this.config.heatpumpSetTempStateId, target); await this.setActorState(this.config.heatpumpPowerStateId, true); this.lastHeatpumpSwitch = now; await this.setStateAsync('status.heatpump.lastAction', 'EIN', true); await this.setStateAsync('status.heatpump.lastReason', `Energiequelle: ${energySource}`, true); } else { await this.setStateAsync('status.heatpump.lastReason', `Läuft weiter (${energySource})`, true); } }
  async loop() { await this.setStateAsync('status.debug.lastCycle', new Date().toISOString(), true); await this.pumpTick(); await this.phPreview(); await this.phTick(); await this.chlorTick(); await this.heatpumpTick(); }
}
if (require.main !== module) { module.exports = options => new Poolsteuerung(options); } else { (() => new Poolsteuerung())(); }

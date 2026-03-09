'use strict';

const utils = require('@iobroker/adapter-core');

class PoolPilot extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'poolpilot' });
        this.dosingActive = false;
        this.dosingTimer = null;
        this.dosingInterval = null;
        this.dosingStartedAt = 0;
        this.orpCheckInterval = null;
        this.heatCheckInterval = null;
        this.scheduleTimers = [];

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.createStates();
        await this.subscribeConfiguredStates();

        await this.setStateAsync('info.connection', true, true);
        await this.updateNextDoseTime();
        await this.recalculateDosePreview();
        await this.evaluateOrp();
        await this.evaluateHeating();

        this.createDailySchedules();
        this.orpCheckInterval = setInterval(() => this.evaluateOrp().catch(err => this.log.warn(err.message)), 60_000);
        this.heatCheckInterval = setInterval(() => this.evaluateHeating().catch(err => this.log.warn(err.message)), 120_000);

        this.log.info('PoolPilot started');
    }

    async createStates() {
        const defs = [
            ['control.manualDoseTrigger', false, { type: 'boolean', role: 'button' }],
            ['control.dosingEnabled', true, { type: 'boolean', role: 'switch' }],
            ['control.orpAutoEnabled', true, { type: 'boolean', role: 'switch' }],
            ['status.dosingActive', false, { type: 'boolean', role: 'indicator.working' }],
            ['status.chlorinatorStateText', '', { type: 'string', role: 'text' }],
            ['status.heatingStateText', '', { type: 'string', role: 'text' }],
            ['status.nextDoseTime', '', { type: 'string', role: 'text' }],
            ['status.lastAction', '', { type: 'string', role: 'text' }],
            ['status.lastOrpSwitchIso', '', { type: 'string', role: 'text' }],
            ['calc.poolVolumeL', this.getPoolVolumeL(), { type: 'number', role: 'value', unit: 'l' }],
            ['calc.plannedDoseMl', 0, { type: 'number', role: 'value', unit: 'ml' }],
            ['calc.plannedDoseSeconds', 0, { type: 'number', role: 'value', unit: 's' }],
            ['calc.plannedGranulateG', 0, { type: 'number', role: 'value', unit: 'g' }],
            ['calc.actualDoseMl', 0, { type: 'number', role: 'value', unit: 'ml' }],
            ['calc.lastPh', 0, { type: 'number', role: 'value' }],
            ['calc.restSeconds', 0, { type: 'number', role: 'value', unit: 's' }]
        ];

        for (const [id, def, common] of defs) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name: id, read: true, write: common.role === 'button' || common.role === 'switch', def, ...common },
                native: {}
            });
            await this.setStateAsync(id, { val: def, ack: true });
        }
    }

    async subscribeConfiguredStates() {
        this.subscribeStates('control.manualDoseTrigger');

        for (const stateId of [
            this.config.phSensorId,
            this.config.orpSensorId,
            this.config.circulationPumpSocketId,
            this.config.waterTempSensorId,
            this.config.solarSurplusStateId,
            this.config.batteryFullStateId
        ]) {
            if (stateId) this.subscribeForeignStates(stateId);
        }
    }

    onUnload(callback) {
        try {
            this.clearDosingRuntime();
            if (this.orpCheckInterval) clearInterval(this.orpCheckInterval);
            if (this.heatCheckInterval) clearInterval(this.heatCheckInterval);
            for (const timer of this.scheduleTimers) clearTimeout(timer);
            callback();
        } catch {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (!state) return;

        if (id === `${this.namespace}.control.manualDoseTrigger` && state.val === true) {
            await this.startDose('manual');
            return;
        }

        if (id === this.config.phSensorId) {
            await this.recalculateDosePreview();
            return;
        }

        if (id === this.config.orpSensorId || id === this.config.circulationPumpSocketId) {
            await this.evaluateOrp();
            return;
        }

        if ([this.config.waterTempSensorId, this.config.solarSurplusStateId, this.config.batteryFullStateId].includes(id)) {
            await this.evaluateHeating();
        }
    }

    getPoolVolumeL() {
        const r = Number(this.config.poolDiameterM || 0) / 2;
        const h = Number(this.config.waterHeightM || 0);
        return Math.round(Math.PI * r * r * h * 1000);
    }

    async getForeignNumber(id) {
        if (!id) return NaN;
        const state = await this.getForeignStateAsync(id);
        return state ? Number(state.val) : NaN;
    }

    async getForeignBool(id) {
        if (!id) return false;
        const state = await this.getForeignStateAsync(id);
        return !!(state && state.val);
    }

    async setForeignBool(id, value) {
        if (!id) return;
        await this.setForeignStateAsync(id, !!value);
    }

    async recalculateDosePreview() {
        const ph = await this.getForeignNumber(this.config.phSensorId);
        const target = Number(this.config.phTarget);
        const minDelta = Number(this.config.phMinDelta);
        const poolVolumeL = this.getPoolVolumeL();

        if (Number.isNaN(ph)) {
            await this.setStateAsync('status.lastAction', { val: 'pH sensor invalid', ack: true });
            return this.resetDoseCalc();
        }

        const delta = ph - target;
        await this.setStateAsync('calc.lastPh', { val: ph, ack: true });
        await this.setStateAsync('calc.poolVolumeL', { val: poolVolumeL, ack: true });

        if (delta <= minDelta) return this.resetDoseCalc();

        const mlPer01 = Math.max(0, poolVolumeL / 100);
        const base = Math.max(0, delta * 10 * mlPer01);
        const liquidFactor = Number(this.config.liquidFactorPercent || 100) / 100;
        const granFactor = Number(this.config.granulateFactorPercent || 100) / 100;
        const ml = Math.round(base * liquidFactor);
        const g = Math.round(base * granFactor);
        let sec = Math.round((ml / Number(this.config.dosingMlPerMinute || 1)) * 60);
        sec = Math.min(Number(this.config.maxDosingSeconds || 300), Math.max(0, sec));

        await this.setStateAsync('calc.plannedDoseMl', { val: ml, ack: true });
        await this.setStateAsync('calc.plannedGranulateG', { val: g, ack: true });
        await this.setStateAsync('calc.plannedDoseSeconds', { val: sec, ack: true });
    }

    async resetDoseCalc() {
        await this.setStateAsync('calc.plannedDoseMl', { val: 0, ack: true });
        await this.setStateAsync('calc.plannedGranulateG', { val: 0, ack: true });
        await this.setStateAsync('calc.plannedDoseSeconds', { val: 0, ack: true });
        await this.setStateAsync('calc.restSeconds', { val: 0, ack: true });
        await this.setStateAsync('calc.actualDoseMl', { val: 0, ack: true });
    }

    async startDose(reason) {
        if (this.dosingActive) return;

        const dosingEnabled = await this.getStateAsync('control.dosingEnabled');
        if (!dosingEnabled?.val) return this.logAction('Dosing skipped: disabled');

        const pumpOn = await this.getForeignBool(this.config.circulationPumpSocketId);
        if (!pumpOn) return this.logAction('Dosing skipped: circulation pump off');

        await this.recalculateDosePreview();
        const ml = Number((await this.getStateAsync('calc.plannedDoseMl'))?.val || 0);
        const sec = Number((await this.getStateAsync('calc.plannedDoseSeconds'))?.val || 0);

        if (ml <= 0 || sec <= 0) {
            await this.setStateAsync('control.manualDoseTrigger', { val: false, ack: true });
            return this.logAction('Dosing skipped: no dosing demand');
        }

        this.dosingActive = true;
        this.dosingStartedAt = Date.now();
        await this.setStateAsync('status.dosingActive', { val: true, ack: true });
        await this.setStateAsync('calc.actualDoseMl', { val: 0, ack: true });
        await this.setStateAsync('calc.restSeconds', { val: sec, ack: true });
        await this.setForeignBool(this.config.dosingSocketId, true);
        await this.logAction(`Dosing started (${reason}): ${ml} ml / ${sec} s`);

        this.dosingInterval = setInterval(async () => {
            const current = await this.getStateAsync('calc.restSeconds');
            const rest = Math.max(0, Number(current?.val || 0) - 1);
            await this.setStateAsync('calc.restSeconds', { val: rest, ack: true });
        }, 1000);

        this.dosingTimer = setTimeout(async () => {
            await this.stopDose(`Dosing completed (${reason})`);
        }, sec * 1000);

        await this.setStateAsync('control.manualDoseTrigger', { val: false, ack: true });
    }

    async stopDose(message) {
        const seconds = Math.max(0, Math.round((Date.now() - this.dosingStartedAt) / 1000));
        const actualMl = Math.round((seconds / 60) * Number(this.config.dosingMlPerMinute || 0));
        await this.setForeignBool(this.config.dosingSocketId, false);
        await this.setStateAsync('calc.actualDoseMl', { val: actualMl, ack: true });
        await this.setStateAsync('status.dosingActive', { val: false, ack: true });
        await this.setStateAsync('calc.restSeconds', { val: 0, ack: true });
        this.clearDosingRuntime();
        await this.logAction(`${message}: actual ${actualMl} ml`);
    }

    clearDosingRuntime() {
        this.dosingActive = false;
        if (this.dosingTimer) clearTimeout(this.dosingTimer);
        if (this.dosingInterval) clearInterval(this.dosingInterval);
        this.dosingTimer = null;
        this.dosingInterval = null;
    }

    async evaluateOrp() {
        const enabled = await this.getStateAsync('control.orpAutoEnabled');
        if (!enabled?.val) return this.setStateAsync('status.chlorinatorStateText', { val: 'ORP auto disabled', ack: true });

        const pumpOn = await this.getForeignBool(this.config.circulationPumpSocketId);
        if (!pumpOn) {
            await this.setForeignBool(this.config.chlorinatorSocketId, false);
            return this.setStateAsync('status.chlorinatorStateText', { val: 'Pump off -> chlorinator off', ack: true });
        }

        const orp = await this.getForeignNumber(this.config.orpSensorId);
        if (Number.isNaN(orp)) return this.setStateAsync('status.chlorinatorStateText', { val: 'ORP invalid', ack: true });

        const chlorState = await this.getForeignBool(this.config.chlorinatorSocketId);
        const lastSwitch = await this.getStateAsync('status.lastOrpSwitchIso');
        const sinceMin = this.minutesSince(lastSwitch?.val);
        const holdMin = chlorState ? Number(this.config.orpMinOnMinutes) : Number(this.config.orpMinOffMinutes);

        if (sinceMin < holdMin) {
            return this.setStateAsync('status.chlorinatorStateText', { val: `Hold ${Math.ceil(holdMin - sinceMin)} min`, ack: true });
        }

        if (chlorState && orp >= Number(this.config.orpOffMv)) {
            await this.setForeignBool(this.config.chlorinatorSocketId, false);
            await this.setStateAsync('status.lastOrpSwitchIso', { val: new Date().toISOString(), ack: true });
            return this.setStateAsync('status.chlorinatorStateText', { val: `OFF (ORP ${orp} >= ${this.config.orpOffMv})`, ack: true });
        }

        if (!chlorState && orp <= Number(this.config.orpOnMv)) {
            await this.setForeignBool(this.config.chlorinatorSocketId, true);
            await this.setStateAsync('status.lastOrpSwitchIso', { val: new Date().toISOString(), ack: true });
            return this.setStateAsync('status.chlorinatorStateText', { val: `ON (ORP ${orp} <= ${this.config.orpOnMv})`, ack: true });
        }

        await this.setStateAsync('status.chlorinatorStateText', { val: `Keep ${chlorState ? 'ON' : 'OFF'} (ORP ${orp})`, ack: true });
    }

    async evaluateHeating() {
        if (!this.config.heatingEnabled || !this.config.heatPumpSwitchId || !this.config.waterTempSensorId) {
            return this.setStateAsync('status.heatingStateText', { val: 'Heating not configured', ack: true });
        }

        const temp = await this.getForeignNumber(this.config.waterTempSensorId);
        if (Number.isNaN(temp)) return this.setStateAsync('status.heatingStateText', { val: 'Water temperature invalid', ack: true });

        const solarOk = !this.config.requireSolarSurplus || await this.getForeignBool(this.config.solarSurplusStateId);
        const batteryOk = !this.config.requireBatteryFull || await this.getForeignBool(this.config.batteryFullStateId);
        const heatOn = await this.getForeignBool(this.config.heatPumpSwitchId);
        const target = Number(this.config.heatTempTargetC);
        const hyst = Number(this.config.heatTempHysteresisC);

        if (!solarOk || !batteryOk) {
            await this.setForeignBool(this.config.heatPumpSwitchId, false);
            return this.setStateAsync('status.heatingStateText', { val: 'Heating off: energy conditions not met', ack: true });
        }

        if (heatOn && temp >= target + hyst) {
            await this.setForeignBool(this.config.heatPumpSwitchId, false);
            return this.setStateAsync('status.heatingStateText', { val: `Heating OFF (${temp}°C >= ${target + hyst}°C)`, ack: true });
        }

        if (!heatOn && temp <= target - hyst) {
            await this.setForeignBool(this.config.heatPumpSwitchId, true);
            return this.setStateAsync('status.heatingStateText', { val: `Heating ON (${temp}°C <= ${target - hyst}°C)`, ack: true });
        }

        await this.setStateAsync('status.heatingStateText', { val: `Heating keep ${heatOn ? 'ON' : 'OFF'} (${temp}°C)`, ack: true });
    }

    createDailySchedules() {
        const times = String(this.config.autoDoseTimes || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        for (const time of times) this.scheduleDaily(time, () => this.startDose(`auto ${time}`).catch(err => this.log.warn(err.message)));
        if (this.config.pumpStartTime) this.scheduleDaily(this.config.pumpStartTime, () => this.setForeignBool(this.config.circulationPumpSocketId, true));
        if (this.config.pumpStopTime) this.scheduleDaily(this.config.pumpStopTime, async () => {
            await this.setForeignBool(this.config.circulationPumpSocketId, false);
            await this.setForeignBool(this.config.chlorinatorSocketId, false);
        });
        if (this.config.chlorinatorStopTime) this.scheduleDaily(this.config.chlorinatorStopTime, async () => {
            const pumpOn = await this.getForeignBool(this.config.circulationPumpSocketId);
            if (pumpOn) await this.setForeignBool(this.config.chlorinatorSocketId, false);
        });
    }

    scheduleDaily(hhmm, fn) {
        const scheduleNext = () => {
            const now = new Date();
            const [h, m] = String(hhmm).split(':').map(Number);
            const next = new Date(now);
            next.setHours(h, m, 0, 0);
            if (next <= now) next.setDate(next.getDate() + 1);
            const ms = next.getTime() - now.getTime();

            const timer = setTimeout(async () => {
                try {
                    await fn();
                } finally {
                    scheduleNext();
                    this.updateNextDoseTime().catch(() => undefined);
                }
            }, ms);
            this.scheduleTimers.push(timer);
        };
        scheduleNext();
    }

    async updateNextDoseTime() {
        const now = new Date();
        const dates = String(this.config.autoDoseTimes || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(t => {
                const [h, m] = t.split(':').map(Number);
                const d = new Date(now);
                d.setHours(h, m, 0, 0);
                if (d <= now) d.setDate(d.getDate() + 1);
                return d;
            })
            .sort((a, b) => a - b);

        if (dates.length) {
            await this.setStateAsync('status.nextDoseTime', { val: dates[0].toLocaleString('de-DE'), ack: true });
        }
    }

    minutesSince(iso) {
        if (!iso) return Number.POSITIVE_INFINITY;
        const t = new Date(iso).getTime();
        if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
        return (Date.now() - t) / 60000;
    }

    async logAction(message) {
        this.log.info(message);
        await this.setStateAsync('status.lastAction', { val: message, ack: true });
    }
}

if (require.main !== module) {
    module.exports = options => new PoolPilot(options);
} else {
    (() => new PoolPilot())();
}

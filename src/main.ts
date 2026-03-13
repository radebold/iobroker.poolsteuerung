
import utils, { type AdapterOptions } from "@iobroker/adapter-core";
import { PhController } from "./controllers/ph";
import { ChlorinatorController } from "./controllers/chlorinator";
import { PumpController } from "./controllers/pump";
import { HeatpumpController } from "./controllers/heatpump";
import type { PoolsteuerungConfig } from "./types";

export class Poolsteuerung extends utils.Adapter {
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly ph = new PhController(this);
    private readonly chlor = new ChlorinatorController(this);
    private readonly pump = new PumpController(this);
    private readonly heat = new HeatpumpController(this);

    public declare config: PoolsteuerungConfig;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: "poolsteuerung" });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.mk("info.connection", "boolean", "indicator.connected", false, false);
        await this.mk("status.overall.message", "string", "text", "", false);
        await this.mk("status.ph.previewMl", "number", "value", 0, false);
        await this.mk("status.ph.previewRuntimeSec", "number", "value", 0, false);
        await this.mk("status.ph.previewGranulateG", "number", "value", 0, false);
        await this.mk("status.ph.lastAction", "string", "text", "", false);
        await this.mk("status.ph.lastDoseMl", "number", "value", 0, false);
        await this.mk("status.chlorinator.lastAction", "string", "text", "", false);
        await this.mk("status.pump.lastAction", "string", "text", "", false);
        await this.mk("control.manualDose", "boolean", "button", false, true);

        await this.setStateAsync("info.connection", true, true);
        await this.setStateAsync("status.overall.message", "Adapter gestartet - TypeScript 0.1.0", true);

        this.subscribeStates("control.manualDose");
        if (this.config.phStateId) this.subscribeForeignStates(this.config.phStateId);
        if (this.config.orpStateId) this.subscribeForeignStates(this.config.orpStateId);

        await this.ph.preview();

        this.timer = setInterval(() => void this.loop(), Math.max(1, Number(this.config.pollIntervalMin) || 1) * 60000);
        this.setTimeout(() => void this.loop(), 2000);
    }

    private async mk(id: string, type: ioBroker.CommonType, role: string, def: ioBroker.StateValue, write: boolean): Promise<void> {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { name: id, type, role, read: true, write, def },
            native: {},
        });
        if (!write) await this.setStateAsync(id, def, true);
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state) return;
        if (id === `${this.namespace}.control.manualDose` && state.val === true && !state.ack) {
            await this.ph.dose("Manuell");
            await this.setStateAsync("control.manualDose", false, true);
        }
        if (id === this.config.phStateId) {
            await this.ph.preview();
        }
    }

    private async loop(): Promise<void> {
        try {
            if (!this.config.adapterEnabled) return;
            await this.pump.tick();
            await this.ph.preview();
            await this.ph.tick();
            await this.chlor.tick();
            await this.heat.tick();
        } catch (error) {
            this.log.error((error as Error).message);
        }
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.timer) clearInterval(this.timer);
            await this.setStateAsync("info.connection", false, true);
            callback();
        } catch {
            callback();
        }
    }

    public async getForeignNumber(id: string): Promise<number | null> {
        if (!id) return null;
        try {
            const s = await this.getForeignStateAsync(id);
            const n = Number(s?.val);
            return Number.isNaN(n) ? null : n;
        } catch {
            return null;
        }
    }

    public async getForeignBoolean(id: string, fb: boolean): Promise<boolean> {
        if (!id) return fb;
        try {
            const s = await this.getForeignStateAsync(id);
            return s ? !!s.val : fb;
        } catch {
            return fb;
        }
    }
}

if (require.main !== module) {
    module.exports = (options?: Partial<AdapterOptions>) => new Poolsteuerung(options);
} else {
    (() => new Poolsteuerung())();
}

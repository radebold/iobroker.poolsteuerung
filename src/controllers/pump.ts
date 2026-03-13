
import type { Poolsteuerung } from "../main";
import { hhmm } from "../utils/helpers";

export class PumpController {
    public constructor(private readonly adapter: Poolsteuerung) {}

    public async tick(): Promise<void> {
        if (!this.adapter.config.pumpEnabled) return;
        const now = hhmm();
        const start = this.adapter.config.pumpStartTime || "";
        const end = this.adapter.config.pumpEndTime || "";
        if (!start || !end) return;
        const shouldRun = now >= start && now < end;
        const state = await this.adapter.getForeignBoolean(this.adapter.config.circulationPumpSocketStateId, false);

        if (shouldRun && !state) {
            await this.adapter.setForeignStateAsync(this.adapter.config.circulationPumpSocketStateId, true);
            await this.adapter.setStateAsync("status.pump.lastAction", `Pumpe EIN ${now}`, true);
        }
        if (!shouldRun && state) {
            await this.adapter.setForeignStateAsync(this.adapter.config.circulationPumpSocketStateId, false);
            await this.adapter.setStateAsync("status.pump.lastAction", `Pumpe AUS ${now}`, true);
        }
    }
}

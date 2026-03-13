
import type { Poolsteuerung } from "../main";
import { hhmm } from "../utils/helpers";

export class ChlorinatorController {
    private last = 0;
    public constructor(private readonly adapter: Poolsteuerung) {}

    public async tick(): Promise<void> {
        if (!this.adapter.config.chlorinatorEnabled) return;
        const orp = await this.adapter.getForeignNumber(this.adapter.config.orpStateId);
        if (orp === null) return;
        const state = await this.adapter.getForeignBoolean(this.adapter.config.chlorinatorSocketStateId, false);
        const pump = await this.adapter.getForeignBoolean(this.adapter.config.circulationPumpSocketStateId, false);

        if ((this.adapter.config.chlorinatorOnlyWhenPumpRunning && !pump) ||
            (this.adapter.config.chlorinatorStopTime && hhmm() >= this.adapter.config.chlorinatorStopTime)) {
            if (state) await this.adapter.setForeignStateAsync(this.adapter.config.chlorinatorSocketStateId, false);
            return;
        }

        const now = Date.now();
        const minOn = (Number(this.adapter.config.chlorinatorMinOnMin) || 0) * 60000;
        const minOff = (Number(this.adapter.config.chlorinatorMinOffMin) || 0) * 60000;

        if (state && orp >= Number(this.adapter.config.orpOff || 780) && now - this.last >= minOn) {
            await this.adapter.setForeignStateAsync(this.adapter.config.chlorinatorSocketStateId, false);
            this.last = now;
            await this.adapter.setStateAsync("status.chlorinator.lastAction", `AUS bei ORP ${orp}`, true);
        } else if (!state && orp <= Number(this.adapter.config.orpOn || 720) && now - this.last >= minOff) {
            await this.adapter.setForeignStateAsync(this.adapter.config.chlorinatorSocketStateId, true);
            this.last = now;
            await this.adapter.setStateAsync("status.chlorinator.lastAction", `EIN bei ORP ${orp}`, true);
        }
    }
}


import type { Poolsteuerung } from "../main";

export class HeatpumpController {
    public constructor(private readonly adapter: Poolsteuerung) {}
    public async tick(): Promise<void> {
        if (!this.adapter.config.heatpumpEnabled) return;
    }
}

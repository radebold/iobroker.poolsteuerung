
import utils from "@iobroker/adapter-core";
class Poolsteuerung extends utils.Adapter {
  public constructor(options: any = {}) {
    super({ ...options, name: "poolsteuerung" });
    this.on("ready", this.onReady.bind(this));
  }
  private async onReady(): Promise<void> {
    this.log.info("Poolsteuerung adapter started");
  }
}
if (require.main !== module) {
  module.exports = (options: any) => new Poolsteuerung(options);
} else {
  (() => new Poolsteuerung())();
}

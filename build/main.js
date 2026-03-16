
'use strict';
const utils = require('@iobroker/adapter-core');

class Poolsteuerung extends utils.Adapter {

    constructor(options = {}) {
        super({
            ...options,
            name: 'poolsteuerung'
        });
        this.on('ready', this.onReady.bind(this));
    }

    async onReady() {
        this.log.info('poolsteuerung 0.1.3 started');

        const debug = this.config.debug;

        if (debug) {
            this.log.info('[DEBUG] Adapter gestartet');
        }

        // Beispiel Zyklus
        setInterval(async () => {
            if (debug) this.log.info('[DEBUG] cycle start');

        }, 60000);

    }
}

if (require.main !== module) {
    module.exports = (options) => new Poolsteuerung(options);
} else {
    (() => new Poolsteuerung())();
}


'use strict';
const utils = require('@iobroker/adapter-core');

class Poolsteuerung extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'poolsteuerung'
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.log.info('poolsteuerung adapter started');
        await this.setStateAsync('info.connection', true, true);
        await this.setStateAsync('status.overall.message', 'Adapter gestartet - Admin-Konfiguration erweitert', true);
    }

    async onUnload(callback) {
        try {
            await this.setStateAsync('info.connection', false, true);
            callback();
        } catch (e) {
            callback();
        }
    }

    onStateChange(id, state) {
        if (!state) return;
        if (!state.ack) {
            this.log.debug(`stateChange ${id}: ${state.val}`);
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Poolsteuerung(options);
} else {
    new Poolsteuerung();
}

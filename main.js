
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
        this.log.info('Poolsteuerung adapter started');
        await this.setState('info.connection', true, true);
    }

    onUnload(callback) {
        try {
            this.setState('info.connection', false, true);
            callback();
        } catch (e) {
            callback();
        }
    }

    onStateChange(id, state) {
        if (state && !state.ack) {
            this.log.debug(`State changed: ${id} = ${state.val}`);
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Poolsteuerung(options);
} else {
    new Poolsteuerung();
}

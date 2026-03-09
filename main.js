
'use strict';
const utils = require('@iobroker/adapter-core');

class Poolsteuerung extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'poolsteuerung'
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
    }

    async onReady() {
        this.log.info('poolsteuerung adapter started');
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: {
                name: 'Connection',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false
            },
            native: {}
        });
        await this.setObjectNotExistsAsync('status.overall.message', {
            type: 'state',
            common: {
                name: 'Overall status message',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: ''
            },
            native: {}
        });
        await this.setStateAsync('info.connection', true, true);
        await this.setStateAsync('status.overall.message', 'Adapter gestartet - Version 0.0.2', true);
        this.subscribeStates('*');
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
        if (!state || state.ack) return;
        this.log.debug(`stateChange ${id}: ${state.val}`);
    }
}

if (require.main !== module) {
    module.exports = options => new Poolsteuerung(options);
} else {
    new Poolsteuerung();
}

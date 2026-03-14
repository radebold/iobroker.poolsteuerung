
'use strict';
const utils = require('@iobroker/adapter-core');

class Poolsteuerung extends utils.Adapter {

    constructor(options = {}) {
        super({ ...options, name: 'poolsteuerung' });
        this.on('ready', this.onReady.bind(this));
    }

    async onReady() {
        this.log.info('Poolsteuerung adapter started');
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: {
                name: 'Connection',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.setStateAsync('info.connection', true, true);
    }
}

if (require.main !== module) {
    module.exports = options => new Poolsteuerung(options);
} else {
    (() => new Poolsteuerung())();
}

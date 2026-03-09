
'use strict';
const utils = require('@iobroker/adapter-core');

class Poolsteuerung extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'poolsteuerung'
        });

        this.on('ready', this.onReady.bind(this));
    }

    async onReady() {
        this.log.info('poolsteuerung adapter started');
    }
}

if (require.main !== module) {
    module.exports = options => new Poolsteuerung(options);
} else {
    new Poolsteuerung();
}

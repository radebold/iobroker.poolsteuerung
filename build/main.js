
'use strict';
const utils = require('@iobroker/adapter-core');

function parseNum(v){
    if(v === undefined || v === null) return 0;
    return Number(String(v).replace(',', '.'));
}

class Poolsteuerung extends utils.Adapter {

    constructor(options = {}) {
        super({...options, name: 'poolsteuerung'});
        this.on('ready', this.onReady.bind(this));
    }

    async calculateVolume(){

        const d = parseNum(this.config.poolDiameterM);
        const h = parseNum(this.config.poolWaterHeightM);

        if(!d || !h){
            this.log.warn("Durchmesser oder Höhe nicht gesetzt");
            return;
        }

        const volume = Math.PI * Math.pow(d/2,2) * h;
        const result = Number(volume.toFixed(2));

        await this.setObjectNotExistsAsync("info.poolVolume", {
            type: "state",
            common:{
                name:"Poolvolumen",
                type:"number",
                role:"value.volume",
                unit:"m3",
                read:true,
                write:false
            },
            native:{}
        });

        await this.setStateAsync("info.poolVolume", {
            val: result,
            ack:true
        });

        this.log.info("Poolvolumen berechnet: " + result + " m3");

    }

    async onReady(){

        await this.calculateVolume();

    }
}

if (require.main !== module) {
    module.exports = options => new Poolsteuerung(options);
} else {
    (() => new Poolsteuerung())();
}

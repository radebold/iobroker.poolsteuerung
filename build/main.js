
'use strict';
const utils = require('@iobroker/adapter-core');

class Poolsteuerung extends utils.Adapter {
 constructor(options={}){
  super({...options,name:'poolsteuerung'});
  this.on('ready',this.onReady.bind(this));
 }

 calcVolume(){
  const d = Number(this.config.poolDiameterM);
  const h = Number(this.config.poolWaterHeightM);
  if(!d || !h) return 0;
  return Number((Math.PI*Math.pow(d/2,2)*h).toFixed(2));
 }

 async onReady(){
  const vol=this.calcVolume();
  this.log.info('Poolvolumen berechnet: '+vol+' m3');
 }
}

if (require.main !== module) {
 module.exports = options => new Poolsteuerung(options);
} else {
 (() => new Poolsteuerung())();
}

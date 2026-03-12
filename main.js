
'use strict';
const utils=require('@iobroker/adapter-core');

class poolsteuerung extends utils.Adapter{
 constructor(options){
  super({...options,name:'poolsteuerung'});
  this.on('ready',this.onReady.bind(this));
 }
 async onReady(){
  this.log.info('poolsteuerung started');
 }
}

if(require.main!==module){
 module.exports=options=>new poolsteuerung(options);
}else{
 new poolsteuerung();
}

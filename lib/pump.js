
'use strict';
const {hhmm}=require('./helpers');
class Pump {
  constructor(a){this.a=a;}
  async tick(){
    if(!this.a.config.pumpEnabled) return;
    const now=hhmm(), start=this.a.config.pumpStartTime||'', end=this.a.config.pumpEndTime||'';
    if(!start||!end) return;
    const shouldRun = now>=start && now<end;
    const state = await this.a.bool(this.a.config.circulationPumpSocketStateId,false);
    if(shouldRun && !state){await this.a.setForeignStateAsync(this.a.config.circulationPumpSocketStateId,true); await this.a.setStateAsync('status.pump.lastAction','Pumpe EIN '+now,true);}
    if(!shouldRun && state){await this.a.setForeignStateAsync(this.a.config.circulationPumpSocketStateId,false); await this.a.setStateAsync('status.pump.lastAction','Pumpe AUS '+now,true);}
  }
}
module.exports=Pump;

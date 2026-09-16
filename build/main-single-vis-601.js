'use strict';

// 0.6.1: Standby aus Admin-Konfiguration ist authoritative.
// VIS-Architektur bleibt unverändert bei genau einem Owner aus 0.6.0.
const createBase = require('./main-single-vis-600.js');

function install(adapter) {
  if (!adapter || adapter.__standby601Installed) return adapter;
  adapter.__standby601Installed = true;

  const baseGetControlBool = adapter.getControlBool.bind(adapter);

  // Wichtig: ensureControlState() überschreibt einen bereits vorhandenen
  // control.standby State nicht. Dadurch konnte config.standbyModeEnabled=true
  // wirkungslos bleiben, wenn control.standby noch false war.
  // Für Standby gilt deshalb: Admin-Konfiguration EIN erzwingt Standby;
  // andernfalls bleibt der Laufzeit-State (VIS-Schalter) maßgeblich.
  adapter.getControlBool = async function getControlBool601(id, fallback) {
    if (id === 'control.standby' && adapter.config && adapter.config.standbyModeEnabled === true) {
      return true;
    }
    return baseGetControlBool(id, fallback);
  };

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        if (adapter.config && adapter.config.standbyModeEnabled === true) {
          // Anzeige-/Bedienstate mit der Admin-Konfiguration synchronisieren.
          await adapter.setStateIfChanged('control.standby', true, true);
          adapter.beginControlTransition(10000);
          await adapter.resetManualBlockers('Standby aus Admin-Konfiguration');
          adapter.clearPendingRenderTimeouts('Standby aus Admin-Konfiguration');
          adapter.resetHeatpumpLocks('Standby aus Admin-Konfiguration');

          // Abhängige Verbraucher sofort sicher AUS. Die Umwälzpumpe wird
          // anschließend ausschließlich durch isStandbyPumpActive() für den
          // konfigurierten täglichen Kurzlauf freigegeben.
          await adapter.forceDependentDevicesOff('Standby aus Admin-Konfiguration');
          if (adapter.config.circulationPumpSocketStateId && !adapter.isStandbyPumpActive(new Date())) {
            await adapter.forceSwitchOffCompat(adapter.config.circulationPumpSocketStateId);
            await adapter.setStateIfChanged('control.device.circulation', false, true);
          }
        }

        await adapter.applyControlLogic();
        await adapter.syncControlStates();
        await adapter.syncDeviceControlStates();
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        await adapter.renderVisFull(true);
        await adapter.setObjectNotExistsAsync('status.debug.standby601', {
          type:'state',
          common:{name:'Standby Admin-Sync 0.6.1',type:'string',role:'text',read:true,write:false,def:''},
          native:{}
        });
        await adapter.setStateAsync('status.debug.standby601',
          `Standby=${await adapter.getControlBool('control.standby', false) ? 'EIN' : 'AUS'} · config=${adapter.config && adapter.config.standbyModeEnabled === true ? 'EIN' : 'AUS'}`,
          true);
      } catch (e) {
        if (!adapter.isDbClosedError(e)) adapter.log.error('[STANDBY 0.6.1] Admin-Sync fehlgeschlagen: ' + (e && e.stack ? e.stack : e));
      }
    }, 1200));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

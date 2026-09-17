'use strict';

// 0.6.2: Standby bleibt ein Betriebsmodus, aber die VIS darf ihn jederzeit
// deaktivieren und die Umwälzpumpe im Standby manuell schalten.
// Single-VIS-Owner bleibt unverändert in 0.6.0.
const createBase = require('./main-single-vis-600.js');

function install(adapter) {
  if (!adapter || adapter.__standby602Installed) return adapter;
  adapter.__standby602Installed = true;

  // Die Admin-Option ist nur der Startwert. Danach ist control.standby die
  // Runtime-Wahrheit, damit der VIS-Schalter Standby wieder verlassen kann.
  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        const existing = await adapter.getStateAsync('control.standby');
        if (!existing || existing.val === null || existing.val === undefined) {
          await adapter.setStateIfChanged('control.standby', adapter.config && adapter.config.standbyModeEnabled === true, true);
        }
        await adapter.setObjectNotExistsAsync('status.debug.standby602', {
          type:'state', common:{name:'Standby Runtime 0.6.2',type:'string',role:'text',read:true,write:false,def:''}, native:{}
        });
        await adapter.setStateAsync('status.debug.standby602', 'Runtime-State control.standby ist maßgeblich; manuelle Umwälzpumpe im Standby erlaubt', true);
      } catch (e) {
        if (!adapter.isDbClosedError(e)) adapter.log.warn('[STANDBY 0.6.2] Initialisierung fehlgeschlagen: ' + (e.message || e));
      }
    }, 1400));
  });

  // Originale StateChange-Verarbeitung gezielt ergänzen. Wir fangen nur die
  // zwei Standby-Bedienfälle ab; alle anderen Controls laufen unverändert durch
  // main.js.
  const listeners = adapter.listeners('stateChange');
  const original = listeners.length ? listeners[listeners.length - 1] : null;
  if (original) {
    adapter.removeListener('stateChange', original);
    adapter.on('stateChange', async (id, state) => {
      if (!state || state.ack === true) return original.call(adapter, id, state);

      if (id === `${adapter.namespace}.control.standby`) {
        try {
          const requested = !!state.val;
          adapter.beginControlTransition(10000);
          adapter.clearPendingRenderTimeouts('Standby VIS gewechselt');
          adapter.resetHeatpumpLocks('Standby VIS gewechselt');
          await adapter.setStateIfChanged('control.standby', requested, true);

          if (requested) {
            await adapter.setStateIfChanged('control.auto.circulation', false, true);
            await adapter.setStateIfChanged('control.auto.chlor', false, true);
            await adapter.setStateIfChanged('control.auto.ph', false, true);
            await adapter.setStateIfChanged('control.auto.heatpump', false, true);
            await adapter.forceDependentDevicesOff('Standby aktiv');
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
          await adapter.forceImmediateRender();
          adapter.queueDelayedRefresh(1200);
          return;
        } catch (e) {
          if (!adapter.isDbClosedError(e)) adapter.log.error('[STANDBY 0.6.2] VIS Standby-Schalter fehlgeschlagen: ' + (e.stack || e));
          return;
        }
      }

      if (id === `${adapter.namespace}.control.device.circulation`) {
        const standby = await adapter.getControlBool('control.standby', adapter.config.standbyModeEnabled === true);
        if (standby) {
          try {
            const requested = !!state.val;
            adapter.beginControlTransition(10000);
            adapter.clearPendingRenderTimeouts('Manuelle Pumpe im Standby');
            const ok = requested
              ? await adapter.forceSwitchOnCompat(adapter.config.circulationPumpSocketStateId)
              : await adapter.forceSwitchOffCompat(adapter.config.circulationPumpSocketStateId);
            await adapter.setStateIfChanged('control.device.circulation', requested && !!ok, true);
            if (!requested) await adapter.forceDependentDevicesOff('Umwälzpumpe im Standby manuell AUS');
            await adapter.syncDeviceControlStates();
            adapter.lastRenderSignature = '';
            adapter.lastRenderAt = 0;
            await adapter.renderVisFull(true);
            adapter.queueDelayedRefresh(1200);
            return;
          } catch (e) {
            if (!adapter.isDbClosedError(e)) adapter.log.error('[STANDBY 0.6.2] Manuelle Umwälzpumpe fehlgeschlagen: ' + (e.stack || e));
            return;
          }
        }
      }

      return original.call(adapter, id, state);
    });
  }

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

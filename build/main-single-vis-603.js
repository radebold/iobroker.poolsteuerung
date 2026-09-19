'use strict';

// 0.6.3: Admin-Standby-Option ist der verbindliche Startwert nach jedem
// Adapterstart. Danach bleibt control.standby die Runtime-Wahrheit der VIS.
const createBase = require('./main-single-vis-602.js');

function install(adapter) {
  if (!adapter || adapter.__standby603Installed) return adapter;
  adapter.__standby603Installed = true;

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        const desired = adapter.config && adapter.config.standbyModeEnabled === true;
        const currentState = await adapter.getStateAsync('control.standby');
        const current = !!(currentState && currentState.val);

        await adapter.setObjectNotExistsAsync('status.debug.standby603', {
          type: 'state',
          common: { name: 'Standby Startwert Sync 0.6.3', type: 'string', role: 'text', read: true, write: false, def: '' },
          native: {}
        });

        if (!currentState || currentState.val === null || currentState.val === undefined || current !== desired) {
          adapter.beginControlTransition(10000);
          adapter.clearPendingRenderTimeouts('Standby Startwert 0.6.3');
          adapter.resetHeatpumpLocks('Standby Startwert 0.6.3');
          await adapter.setStateIfChanged('control.standby', desired, true);

          if (desired) {
            await adapter.setStateIfChanged('control.auto.circulation', false, true);
            await adapter.setStateIfChanged('control.auto.chlor', false, true);
            await adapter.setStateIfChanged('control.auto.ph', false, true);
            await adapter.setStateIfChanged('control.auto.heatpump', false, true);
            await adapter.forceDependentDevicesOff('Standby Startwert aktiv');
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
        }

        await adapter.setStateAsync(
          'status.debug.standby603',
          `Admin-Startwert ${desired ? 'EIN' : 'AUS'} -> control.standby ${desired ? 'EIN' : 'AUS'} synchronisiert`,
          true
        );
      } catch (e) {
        if (!adapter.isDbClosedError(e)) adapter.log.warn('[STANDBY 0.6.3] Startwert-Synchronisierung fehlgeschlagen: ' + (e.stack || e));
      }
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

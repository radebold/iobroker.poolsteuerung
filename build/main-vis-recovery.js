'use strict';

const createBase = require('./main-phcalibration.js');

const VERSION = 'v0.4.15';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.htmlPhone',
  'vis.widgetTablet',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.(?:5|6|7|8|9|10|11|12|13|14)/g, VERSION);
}

function installRecovery(adapter) {
  if (!adapter || adapter.__visRecoveryInstalled) return adapter;
  adapter.__visRecoveryInstalled = true;

  // Nur die Versionsanzeige ändern. Keine zusätzlichen Dialoge, Styles oder Skripte
  // in die bestehenden VIS-Dokumente injizieren.
  for (const methodName of ['buildTabletHtml', 'buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget']) {
    if (typeof adapter[methodName] !== 'function') continue;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function buildRecoveredVis(data) {
      return patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
    };
  }

  async function rebuildVisStates(label) {
    if (adapter.isShuttingDown) return;
    try {
      for (const id of VIS_STATES) {
        try {
          await adapter.ensureState(id, 'string', 'html', '', false);
          await adapter.setStateAsync(id, '', true);
        } catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn(`[VIS-RECOVERY] ${id} konnte nicht geleert werden: ${error.message || error}`);
        }
      }

      adapter.lastTabletHtml = '';
      adapter.lastPhoneHtml = '';
      adapter.lastTabletWidget = '';
      adapter.lastPhoneWidget = '';
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;

      await adapter.forceImmediateRender();

      const tablet = await adapter.getStateAsync('vis.htmlTablet');
      const widget = await adapter.getStateAsync('vis.widgetTablet');
      const tabletLength = tablet && typeof tablet.val === 'string' ? tablet.val.length : 0;
      const widgetLength = widget && typeof widget.val === 'string' ? widget.val.length : 0;
      adapter.log.info(`[VIS-RECOVERY] ${label}: Tablet=${tabletLength} Zeichen, Widget=${widgetLength} Zeichen neu erzeugt`);
    } catch (error) {
      if (!adapter.isDbClosedError(error)) adapter.log.warn('[VIS-RECOVERY] Wiederherstellung fehlgeschlagen: ' + (error.message || error));
    }
  }

  adapter.on('ready', () => {
    const first = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(first);
      await rebuildVisStates('erster Lauf');

      const second = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(second);
        if (adapter.isShuttingDown) return;
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        await adapter.forceImmediateRender();
        adapter.log.info('[VIS-RECOVERY] zweiter Kontroll-Render abgeschlossen');
      }, 3500));
    }, 7000));
  });

  try {
    adapter.log.info('[VIS-RECOVERY] v0.4.15: beschädigte Dialogeinbettung deaktiviert, VIS-Neuaufbau aktiv');
  } catch {}

  return adapter;
}

function createAdapter(options = {}) {
  return installRecovery(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

// 0.5.20: Selbst-Neustart durch pH-Minus-Waage beseitigt.
// Der laufende Adapter darf Messwerte niemals in system.adapter.<namespace>.native
// zurückschreiben. Änderungen an native gelten für ioBroker als Konfigurationsänderung
// und können einen Neustart der Instanz auslösen.
const createBase = require('./main-ipadmini-final-519.js');

const VERSION = 'v0.5.20';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__phScaleNoNativeWrite520Installed) return adapter;
  adapter.__phScaleNoNativeWrite520Installed = true;

  // Primärschutz: Auch wenn bestehender Code updatePhCanisterFromScale(true)
  // aufruft, wird das persistNative-Flag zwangsweise auf false gesetzt.
  if (typeof adapter.updatePhCanisterFromScale === 'function') {
    const originalUpdateFromScale = adapter.updatePhCanisterFromScale.bind(adapter);
    adapter.updatePhCanisterFromScale = async function updatePhCanisterFromScaleNoNativeWrite() {
      return originalUpdateFromScale(false);
    };
  }

  // Zweiter Schutz: Die einzige bekannte Routine, die system.adapter.*.native
  // beschreibt, wird vollständig stillgelegt. Die aktuellen Waagenwerte bleiben
  // in status.phCanister.* und werden weiterhin normal in VIS/Regelung verwendet.
  adapter.persistPhCanisterNetToNative = async function persistPhCanisterNetToNativeDisabled() {
    return false;
  };

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchExistingStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = patchVersion(current);
        if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
      } catch {}
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState('status.debug.phCanisterNativePersistence', 'string', 'text', '', false);
        await adapter.setStateIfChanged(
          'status.debug.phCanisterNativePersistence',
          '0.5.20: AUS – Waagenwerte werden nur in States geführt; kein Schreibzugriff auf system.adapter.poolsteuerung.0.native.',
          true
        );
        await patchExistingStates();
      } catch {}
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info('[PH-WAAGE 0.5.20] Native-Persistenz deaktiviert; Waagenwerte erzeugen keine Adapter-Konfigurationsänderung mehr.');
      }
    }, 800));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

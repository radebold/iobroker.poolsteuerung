'use strict';

const createBase = require('./main-ipadmini-final-069.js');

const VERSION = 'v0.4.70';
const CHECK_TRIGGER = 'update.checkTrigger';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

async function patchExistingStates(adapter) {
  for (const id of VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.config.debugMode) {
        adapter.log.debug(`[UPDATE] Versionsanzeige ${id} konnte nicht aktualisiert werden: ${error.message || error}`);
      }
    }
  }
}

async function triggerUpdateCheck(adapter, reason) {
  if (!adapter || adapter.isShuttingDown) return;
  try {
    await adapter.setStateAsync(CHECK_TRIGGER, Date.now(), true);
    if (adapter.config.debugMode && adapter.log && typeof adapter.log.debug === 'function') {
      adapter.log.debug(`[UPDATE] ${reason}: GitHub-Prüfung angefordert`);
    }
  } catch (error) {
    if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
      adapter.log.warn(`[UPDATE] GitHub-Prüfung konnte nicht angefordert werden: ${error.message || error}`);
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__updateRefresh070Installed) return adapter;
  adapter.__updateRefresh070Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates(adapter);
      return result;
    };
  }

  adapter.on('ready', () => {
    const startup = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(startup);
      if (adapter.isShuttingDown) return;
      await patchExistingStates(adapter);
      await triggerUpdateCheck(adapter, 'Prüfung nach Adapterstart');
    }, 12000));

    const timer = setInterval(() => {
      triggerUpdateCheck(adapter, 'Automatische 5-Minuten-Prüfung').catch(() => {});
    }, CHECK_INTERVAL_MS);
    if (typeof adapter.trackInterval === 'function') adapter.trackInterval(timer);

    if (adapter.log && typeof adapter.log.info === 'function') {
      adapter.log.info(`[UPDATE] ${VERSION}: GitHub-Prüfung nach Start und alle 5 Minuten aktiv`);
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

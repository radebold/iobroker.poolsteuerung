'use strict';

const createBase = require('./main-phcalibration-fragment.js');

const VERSION = 'v0.4.41';
const IPAD_STATE = 'vis.htmlIpadMini';

function patchVersion(html) {
  return String(html || '').replace(/v0\.4\.\d+/g, VERSION);
}

function install(adapter) {
  if (!adapter || adapter.__ipadMiniStableInstalled) return adapter;
  adapter.__ipadMiniStableInstalled = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  const baseRender = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async (...args) => {
    const result = await baseRender(...args);
    try {
      const state = await adapter.getStateAsync(IPAD_STATE);
      const html = String((state && state.val) || '');
      if (html.includes('</html>')) await adapter.setStateIfChanged(IPAD_STATE, patchVersion(html), true);
    } catch (error) {
      if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Versionsanzeige konnte nicht aktualisiert werden: ' + (error.message || error));
    }
    return result;
  };

  adapter.on('ready', () => {
    for (const delay of [900, 3200, 7000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        try {
          if (delay === 900) await adapter.setStateAsync(IPAD_STATE, '', true);
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
          await adapter.forceImmediateRender();
          const state = await adapter.getStateAsync(IPAD_STATE);
          const html = patchVersion(String((state && state.val) || ''));
          if (!html.includes('</html>') || html.length < 1000) throw new Error('iPad-Mini-HTML wurde nicht vollständig erzeugt');
          await adapter.setStateIfChanged(IPAD_STATE, html, true);
          if (delay === 3200) adapter.log.info(`[IPAD-MINI] ${VERSION}: stabile vollständige Ansicht wiederhergestellt (${Buffer.byteLength(html, 'utf8')} Bytes)`);
        } catch (error) {
          if (!adapter.isDbClosedError(error)) adapter.log.warn('[IPAD-MINI] Wiederherstellung fehlgeschlagen: ' + (error.message || error));
        }
      }, delay));
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

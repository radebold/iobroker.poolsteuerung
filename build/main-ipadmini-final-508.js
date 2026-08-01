'use strict';

const createBase = require('./main-ipadmini-final-507.js');

const CHECK_NOW = 'update.checkNow';
const INSTALL_NOW = 'update.installNow';
const CHECK_TRIGGER = 'update.checkTrigger';
const INSTALL_TRIGGER = 'update.installTrigger';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone'];
const ALL_VIS_STATES = [...VIS_STATES, 'vis.htmlIpadMini'];
const AUTO_CHECK_MS = 60 * 1000;

function patchUpdateButton(value, namespace) {
  let html = String(value || '');
  if (!html) return html;

  const checkOld = `${namespace}.${CHECK_TRIGGER}`;
  const installOld = `${namespace}.${INSTALL_TRIGGER}`;
  const checkNew = `${namespace}.${CHECK_NOW}`;
  const installNew = `${namespace}.${INSTALL_NOW}`;

  // Nur den vorhandenen Update-Button verändern. Alle übrigen VIS-Handler bleiben unangetastet.
  html = html.replace(/<button\b(?=[^>]*data-pool-update(?:-068|-manifest)?=)[^>]*>[\s\S]*?<\/button>/gi, button => {
    return button
      .replaceAll(checkOld, checkNew)
      .replaceAll(installOld, installNew)
      .replace(/w\(id,Date\.now\(\)\)/g, 'w(id,true)');
  });

  return html;
}

function install(adapter) {
  if (!adapter || adapter.__updateButtons508Installed) return adapter;
  adapter.__updateButtons508Installed = true;

  let lastCheckNow = false;
  let lastInstallNow = false;
  let buttonLoopStarted = false;

  async function ensureButtonStates() {
    await adapter.ensureState(CHECK_NOW, 'boolean', 'button', false, true);
    await adapter.ensureState(INSTALL_NOW, 'boolean', 'button', false, true);
    await adapter.setStateAsync(CHECK_NOW, false, true);
    await adapter.setStateAsync(INSTALL_NOW, false, true);
  }

  async function bridgeButtonStates() {
    if (adapter.isShuttingDown) return;
    try {
      const [checkState, installState] = await Promise.all([
        adapter.getStateAsync(CHECK_NOW),
        adapter.getStateAsync(INSTALL_NOW)
      ]);
      const checkNow = !!(checkState && checkState.val);
      const installNow = !!(installState && installState.val);

      if (checkNow && !lastCheckNow) {
        await adapter.setStateAsync(CHECK_NOW, false, true);
        await adapter.setStateAsync(CHECK_TRIGGER, Date.now(), false);
        if (adapter.log && typeof adapter.log.info === 'function') {
          adapter.log.info('[UPDATE] checkNow: manuelle Update-Prüfung angefordert');
        }
      }

      if (installNow && !lastInstallNow) {
        await adapter.setStateAsync(INSTALL_NOW, false, true);
        await adapter.setStateAsync(INSTALL_TRIGGER, Date.now(), false);
        if (adapter.log && typeof adapter.log.warn === 'function') {
          adapter.log.warn('[UPDATE] installNow: Update-Installation angefordert');
        }
      }

      lastCheckNow = checkNow;
      lastInstallNow = installNow;
    } catch (error) {
      if (!adapter.isDbClosedError || !adapter.isDbClosedError(error)) {
        if (adapter.log && typeof adapter.log.warn === 'function') {
          adapter.log.warn('[UPDATE] Button-Brücke fehlgeschlagen: ' + (error.message || error));
        }
      }
    }
  }

  function startButtonLoop() {
    if (buttonLoopStarted || adapter.isShuttingDown) return;
    buttonLoopStarted = true;
    const interval = setInterval(() => bridgeButtonStates().catch(() => {}), 300);
    if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
  }

  async function patchExistingStates() {
    for (const id of ALL_VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = patchUpdateButton(current, adapter.namespace);
        if (next && next !== current) await adapter.setStateAsync(id, next, true);
      } catch {}
    }
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchUpdateButton(original(data), adapter.namespace);
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates();
      return result;
    };
  }

  async function boot() {
    if (adapter.isShuttingDown) return;
    try {
      await ensureButtonStates();
      startButtonLoop();
      await patchExistingStates();

      // Die eigentliche 0.5.7-Prüfroutine bleibt unverändert. Wir stoßen sie nur intern an.
      const first = setTimeout(() => {
        if (!adapter.isShuttingDown) adapter.setStateAsync(CHECK_TRIGGER, Date.now(), false).catch(() => {});
      }, 5000);
      if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(first);

      const auto = setInterval(() => {
        if (!adapter.isShuttingDown) adapter.setStateAsync(CHECK_TRIGGER, Date.now(), false).catch(() => {});
      }, AUTO_CHECK_MS);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(auto);

      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info('[UPDATE] 0.5.8 Button-Bridge aktiv: checkNow/installNow; automatische Prüfung jede Minute');
      }
    } catch (error) {
      const retry = setTimeout(() => boot().catch(() => {}), 1500);
      if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(retry);
    }
  }

  const starter = setTimeout(() => boot().catch(() => {}), 3200);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(starter);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

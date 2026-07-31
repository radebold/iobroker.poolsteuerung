'use strict';

const https = require('node:https');
const createBase = require('./main-ipadmini-final-500.js');

const CURRENT = '0.5.1';
const VERSION = `v${CURRENT}`;
const RAW_PACKAGE = 'https://raw.githubusercontent.com/radebold/iobroker.poolsteuerung/main/package.json';
const API_PACKAGE = 'https://api.github.com/repos/radebold/iobroker.poolsteuerung/contents/package.json?ref=main';
const TABLET_STATES = ['vis.htmlTablet', 'vis.widgetTablet'];
const ALL_VIS_STATES = [...TABLET_STATES, 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

const IDS = {
  installed: 'update.installedVersion',
  availableVersion: 'update.availableVersion',
  available: 'update.available',
  checkTrigger: 'update.checkTrigger',
  running: 'update.running',
  status: 'update.status',
  lastCheck: 'update.lastCheck',
  lastError: 'update.lastError'
};

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function parseVersion(value) {
  const match = cleanVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]([\w.-]+))?$/);
  return match
    ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], suffix: match[4] || '' }
    : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] > right.numbers[index] ? 1 : -1;
    }
  }
  if (left.suffix === right.suffix) return 0;
  if (!left.suffix) return 1;
  if (!right.suffix) return -1;
  return left.suffix.localeCompare(right.suffix, undefined, { numeric: true, sensitivity: 'base' });
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\r?\n/g, ' ');
}

function requestText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': `ioBroker.poolsteuerung/${CURRENT}`,
        Accept: 'application/vnd.github+json, application/json',
        'Cache-Control': 'no-cache'
      }
    }, response => {
      const status = Number(response.statusCode) || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 4) {
          reject(new Error('Zu viele GitHub-Weiterleitungen'));
          return;
        }
        requestText(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`GitHub HTTP ${status}`));
        return;
      }

      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 262144) request.destroy(new Error('GitHub-Antwort zu groß'));
      });
      response.on('end', () => resolve(text));
      response.on('error', reject);
    });

    request.setTimeout(15000, () => request.destroy(new Error('GitHub-Zeitüberschreitung')));
    request.on('error', reject);
  });
}

async function readRemoteVersion() {
  const errors = [];

  try {
    const data = JSON.parse(await requestText(`${RAW_PACKAGE}?ts=${Date.now()}`));
    const version = cleanVersion(data && data.version);
    if (!parseVersion(version)) throw new Error(`Ungültige Raw-Version: ${version || 'leer'}`);
    return version;
  } catch (error) {
    errors.push(error.message || String(error));
  }

  try {
    const data = JSON.parse(await requestText(`${API_PACKAGE}&ts=${Date.now()}`));
    const decoded = Buffer.from(String(data && data.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
    const pkg = JSON.parse(decoded);
    const version = cleanVersion(pkg && pkg.version);
    if (!parseVersion(version)) throw new Error(`Ungültige API-Version: ${version || 'leer'}`);
    return version;
  } catch (error) {
    errors.push(error.message || String(error));
  }

  throw new Error(errors.join(' | ') || 'GitHub-Version konnte nicht gelesen werden');
}

function clickHandler(namespace) {
  const checkId = `${namespace}.${IDS.checkTrigger}`.replace(/'/g, "\\'");
  const installId = `${namespace}.update.installTrigger`.replace(/'/g, "\\'");

  return escapeAttribute(
    `event.preventDefault();event.stopPropagation();` +
    `var b=this,u=b.dataset.available==='1';` +
    `if(u&&!confirm('Poolsteuerung auf Version '+(b.dataset.target||'neu')+' aktualisieren?'))return false;` +
    `var id=u?'${installId}':'${checkId}',val=Date.now(),ok=false;` +
    `try{if(typeof window.poolSetState==='function'){var r=window.poolSetState(id,val);ok=r!==false;}}catch(e){}` +
    `try{var v=null;if(!ok&&window.vis)v=window.vis;if(!ok&&!v&&window.parent&&window.parent.vis)v=window.parent.vis;if(!ok&&!v&&window.top&&window.top.vis)v=window.top.vis;if(!ok&&v&&v.conn&&typeof v.conn.setState==='function'){v.conn.setState(id,val);ok=true;}}catch(e){}` +
    `if(!ok){alert('Update-Auftrag konnte nicht an ioBroker geschrieben werden.');return false;}` +
    `b.textContent=u?'UPDATE STARTET':'PRÜFE …';b.disabled=true;setTimeout(function(){b.disabled=false;},2500);return false;`
  );
}

function patchTablet(value, namespace, info) {
  let html = patchVersion(value);
  if (!html) return html;

  html = html
    .replace(/<script data-pool-update-runtime-072="1">[\s\S]*?<\/script>/g, '')
    .replace(/\sdata-pool-update-runtime-072="1"/g, '');

  const running = !!info.running;
  const available = !!info.available && compareVersions(info.availableVersion, CURRENT) > 0;
  const hasError = !!info.error && !running;
  const text = running
    ? 'UPDATE LÄUFT'
    : available
      ? `UPDATE ${info.availableVersion}`
      : hasError
        ? 'PRÜFEN'
        : 'AKTUELL';
  const cssClass = running ? 'running' : available ? 'available' : hasError ? 'error' : 'current';
  const title = info.status || `Installiert: ${CURRENT}`;
  const button = `<button type="button" class="pool-update-btn ${cssClass}" data-pool-update-068="1" data-update-501="1" data-available="${available ? 1 : 0}" data-running="${running ? 1 : 0}" data-target="${escapeAttribute(info.availableVersion || '')}" title="${escapeAttribute(title)}" onclick="${clickHandler(namespace)}"${running ? ' disabled' : ''}>${escapeHtml(text)}</button>`;

  if (/<button\b(?=[^>]*data-pool-update-068="1")[^>]*>[\s\S]*?<\/button>/i.test(html)) {
    return html.replace(/<button\b(?=[^>]*data-pool-update-068="1")[^>]*>[\s\S]*?<\/button>/i, button);
  }

  const normalVersion = /(<span class="ver">[^<]*<\/span>)/;
  const widgetVersion = /(<span class="ps-ver">[^<]*<\/span>)/;
  if (normalVersion.test(html)) return html.replace(normalVersion, `$1${button}`);
  if (widgetVersion.test(html)) return html.replace(widgetVersion, `$1${button}`);
  return html;
}

function install(adapter) {
  if (!adapter || adapter.__update501Installed) return adapter;
  adapter.__update501Installed = true;
  adapter.__update501Info = {
    availableVersion: '',
    available: false,
    running: false,
    status: `Installiert: ${CURRENT}`,
    error: ''
  };
  adapter.__update501Busy = false;
  adapter.__update501LastTrigger = null;
  adapter.__update501PatchTimer = null;

  async function ensureStates() {
    try {
      await adapter.setObjectNotExistsAsync('update', {
        type: 'channel',
        common: { name: 'GitHub-Update' },
        native: {}
      });
    } catch {}

    const definitions = [
      [IDS.installed, 'string', 'info.version', CURRENT, false],
      [IDS.availableVersion, 'string', 'info.version', '', false],
      [IDS.available, 'boolean', 'indicator', false, false],
      [IDS.checkTrigger, 'number', 'value.time', 0, true],
      [IDS.running, 'boolean', 'indicator.working', false, false],
      [IDS.status, 'string', 'text', `Installiert: ${CURRENT}`, false],
      [IDS.lastCheck, 'number', 'value.time', 0, false],
      [IDS.lastError, 'string', 'text', '', false]
    ];

    for (const [id, type, role, def, write] of definitions) {
      await adapter.ensureState(id, type, role, def, write);
    }
    await adapter.setStateAsync(IDS.installed, CURRENT, true);
  }

  async function writeInfo(changes) {
    Object.assign(adapter.__update501Info, changes);
    const info = adapter.__update501Info;
    await adapter.setStateAsync(IDS.installed, CURRENT, true);
    await adapter.setStateAsync(IDS.availableVersion, info.availableVersion || '', true);
    await adapter.setStateAsync(IDS.available, !!info.available, true);
    await adapter.setStateAsync(IDS.running, !!info.running, true);
    await adapter.setStateAsync(IDS.status, info.status || '', true);
    await adapter.setStateAsync(IDS.lastError, info.error || '', true);
    if (Object.prototype.hasOwnProperty.call(changes, 'lastCheck')) {
      await adapter.setStateAsync(IDS.lastCheck, Number(changes.lastCheck) || 0, true);
    }
    schedulePatch();
  }

  async function patchStates() {
    for (const id of ALL_VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = TABLET_STATES.includes(id)
          ? patchTablet(current, adapter.namespace, adapter.__update501Info)
          : patchVersion(current);
        if (next && next !== current) await adapter.setStateAsync(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.config.debugMode) {
          adapter.log.debug(`[UPDATE 0.5.1] VIS-Patch ${id}: ${error.message || error}`);
        }
      }
    }
  }

  function schedulePatch() {
    if (adapter.__update501PatchTimer || adapter.isShuttingDown) return;
    const timer = setTimeout(async () => {
      adapter.__update501PatchTimer = null;
      try { await patchStates(); } catch {}
    }, 100);
    adapter.__update501PatchTimer = timer;
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  }

  async function check(reason) {
    if (adapter.__update501Busy || adapter.isShuttingDown) return;
    adapter.__update501Busy = true;
    try {
      await writeInfo({ status: 'Prüfe GitHub auf neue Version …', error: '' });
      const remote = await readRemoteVersion();
      const available = compareVersions(remote, CURRENT) > 0;
      await writeInfo({
        availableVersion: remote,
        available,
        status: available
          ? `Update verfügbar: ${CURRENT} → ${remote}`
          : `Version ${CURRENT} ist aktuell`,
        error: '',
        lastCheck: Date.now()
      });
      adapter.log.info(`[UPDATE 0.5.1] ${reason}: installiert ${CURRENT}, GitHub ${remote}${available ? ' – Update verfügbar' : ''}`);
    } catch (error) {
      const message = error.message || String(error);
      await writeInfo({
        available: false,
        status: 'Update-Prüfung fehlgeschlagen',
        error: message,
        lastCheck: Date.now()
      });
      adapter.log.warn(`[UPDATE 0.5.1] ${message}`);
    } finally {
      adapter.__update501Busy = false;
    }
  }

  async function pollTrigger() {
    try {
      const state = await adapter.getStateAsync(IDS.checkTrigger);
      const value = Number(state && state.val) || 0;
      if (adapter.__update501LastTrigger === null) {
        adapter.__update501LastTrigger = value;
      } else if (value && value !== adapter.__update501LastTrigger) {
        adapter.__update501LastTrigger = value;
        await check('Manuelle Tablet-Prüfung');
      }
    } catch {}
  }

  function startPolling() {
    if (adapter.isShuttingDown) return;
    const timer = setTimeout(async () => {
      try { await pollTrigger(); } finally { startPolling(); }
    }, 750);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchTablet(
      original({ ...(data || {}), adapterVersion: VERSION }),
      adapter.namespace,
      adapter.__update501Info
    );
  }

  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const timer = setTimeout(async () => {
      if (adapter.isShuttingDown) return;
      try {
        await ensureStates();
        const trigger = await adapter.getStateAsync(IDS.checkTrigger);
        adapter.__update501LastTrigger = Number(trigger && trigger.val) || 0;
        startPolling();
        await check('Adapterstart');
        const interval = setInterval(() => {
          check('Automatische Minutenprüfung').catch(() => {});
        }, 60000);
        if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
        adapter.log.info('[UPDATE 0.5.1] Robuste serverseitige Update-Prüfung aktiv');
      } catch (error) {
        if (!adapter.isDbClosedError(error)) {
          adapter.log.error(`[UPDATE 0.5.1] Initialisierung fehlgeschlagen: ${error.message || error}`);
        }
      }
    }, 3200);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

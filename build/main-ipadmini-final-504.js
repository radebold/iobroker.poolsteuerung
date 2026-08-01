'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const createBase = require('./main-ipadmini-final-500.js');

let CURRENT = '0.5.4';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}
const VERSION = `v${CURRENT}`;
const REPO = 'radebold/iobroker.poolsteuerung#main';
const RAW_PACKAGE = 'https://raw.githubusercontent.com/radebold/iobroker.poolsteuerung/main/package.json';
const API_PACKAGE = 'https://api.github.com/repos/radebold/iobroker.poolsteuerung/contents/package.json?ref=main';
const BUTTON_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone'];
const ALL_VIS_STATES = [...BUTTON_STATES, 'vis.htmlIpadMini'];

const IDS = {
  installed: 'update.installedVersion',
  availableVersion: 'update.availableVersion',
  available: 'update.available',
  checkTrigger: 'update.checkTrigger',
  installTrigger: 'update.installTrigger',
  running: 'update.running',
  status: 'update.status',
  lastCheck: 'update.lastCheck',
  lastError: 'update.lastError',
  startedAt: 'update.startedAt',
  targetVersion: 'update.targetVersion',
  remoteSeen: 'update.remoteVersionSeen',
  source: 'update.checkSource'
};

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function parseVersion(value) {
  const match = cleanVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]([\w.-]+))?$/);
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], suffix: match[4] || '' } : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1;
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
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      }
    }, response => {
      const status = Number(response.statusCode) || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 4) return reject(new Error('Zu viele GitHub-Weiterleitungen'));
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
    const data = JSON.parse(await requestText(`${API_PACKAGE}&ts=${Date.now()}`));
    const decoded = Buffer.from(String(data && data.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
    const pkg = JSON.parse(decoded);
    const version = cleanVersion(pkg && pkg.version);
    if (!parseVersion(version)) throw new Error(`Ungültige API-Version: ${version || 'leer'}`);
    return { version, source: 'github-api' };
  } catch (error) {
    errors.push(`API: ${error.message || error}`);
  }

  try {
    const data = JSON.parse(await requestText(`${RAW_PACKAGE}?ts=${Date.now()}`));
    const version = cleanVersion(data && data.version);
    if (!parseVersion(version)) throw new Error(`Ungültige Raw-Version: ${version || 'leer'}`);
    return { version, source: 'github-raw-fallback' };
  } catch (error) {
    errors.push(`RAW: ${error.message || error}`);
  }

  throw new Error(errors.join(' | ') || 'GitHub-Version konnte nicht gelesen werden');
}

function cliInfo() {
  const candidates = [
    path.resolve(__dirname, '../../../iobroker.js'),
    path.resolve(process.cwd(), 'iobroker.js'),
    '/opt/iobroker/iobroker.js'
  ];
  for (const cli of candidates) {
    try {
      if (fs.statSync(cli).isFile()) return { cli, cwd: path.dirname(cli) };
    } catch {}
  }
  return null;
}

function resultFile(namespace) {
  return path.join(os.tmpdir(), `${String(namespace).replace(/[^\w.-]/g, '_')}-github-update-result.json`);
}

function helperCode() {
  return `'use strict';\n` +
    `const fs=require('node:fs'),{spawnSync}=require('node:child_process');\n` +
    `const e=process.env,n=e.POOL_NODE,c=e.POOL_CLI,r=e.POOL_ROOT,f=e.POOL_RESULT,h=e.POOL_HELPER,t=e.POOL_TARGET||'',i=e.POOL_INSTANCE||'poolsteuerung.0';\n` +
    `const tail=v=>{v=String(v||'');return v.length>12000?v.slice(-12000):v};\n` +
    `const run=(a,m)=>spawnSync(n,[c].concat(a),{cwd:r,encoding:'utf8',timeout:m,maxBuffer:8*1024*1024,env:e});\n` +
    `setTimeout(()=>{let x;try{x=run(['url','${REPO}','poolsteuerung'],900000)}catch(q){x={status:-1,error:q}}const ok=!!x&&!x.error&&x.status===0;` +
    `try{fs.writeFileSync(f,JSON.stringify({ts:Date.now(),success:ok,targetVersion:t,code:x&&x.status,stdout:tail(x&&x.stdout),stderr:tail((x&&x.stderr)||(x&&x.error&&x.error.message))},null,2))}catch(q){}` +
    `try{run(['restart',i],120000)}catch(q){}try{fs.unlinkSync(h)}catch(q){}process.exit(ok?0:1)},900);\n`;
}

function clickHandler(namespace) {
  const checkId = `${namespace}.${IDS.checkTrigger}`.replace(/'/g, "\\'");
  const installId = `${namespace}.${IDS.installTrigger}`.replace(/'/g, "\\'");
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

const STYLE = `<style data-pool-update-504="1">
.pool-update-btn{appearance:none;height:25px;margin-left:8px;padding:0 9px;border:1px solid rgba(255,255,255,.15);border-radius:999px;background:rgba(255,255,255,.07);color:#c5d5e8;font:900 8px/1 Arial;white-space:nowrap;vertical-align:middle;cursor:pointer}
.pool-update-btn.available{background:linear-gradient(135deg,#f59e0b,#e87918);border-color:rgba(255,214,117,.55);color:#fff}.pool-update-btn.running{background:linear-gradient(135deg,#278bd4,#25bfb5);color:#fff;cursor:wait}.pool-update-btn.error{background:rgba(255,107,87,.15);border-color:rgba(255,107,87,.35);color:#ffc0b7}.pool-update-btn:disabled{opacity:.7}.ps-title .pool-update-btn{height:22px;margin-left:5px;padding:0 7px;font-size:7px}.ps-header .pool-update-btn{flex:0 0 auto}
</style>`;

function makeButton(namespace, info) {
  const running = !!info.running;
  const available = !!info.available && compareVersions(info.availableVersion, CURRENT) > 0;
  const hasError = !!info.error && !running;
  const text = running ? 'UPDATE LÄUFT' : available ? `UPDATE ${info.availableVersion}` : hasError ? 'PRÜFEN' : 'AKTUELL';
  const cssClass = running ? 'running' : available ? 'available' : hasError ? 'error' : 'current';
  const title = info.status || `Installiert: ${CURRENT}`;
  return `<button type="button" class="pool-update-btn ${cssClass}" data-pool-update-068="1" data-update-504="1" data-available="${available ? 1 : 0}" data-running="${running ? 1 : 0}" data-target="${escapeAttribute(info.availableVersion || '')}" title="${escapeAttribute(title)}" onclick="${clickHandler(namespace)}"${running ? ' disabled' : ''}>${escapeHtml(text)}</button>`;
}

function patchButtonView(value, namespace, info) {
  let html = patchVersion(value);
  if (!html) return html;
  html = html
    .replace(/<script data-pool-update-runtime-072="1">[\s\S]*?<\/script>/g, '')
    .replace(/\sdata-pool-update-runtime-072="1"/g, '')
    .replace(/<style data-pool-update-502="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-504="1">[\s\S]*?<\/style>/g, '');

  const button = makeButton(namespace, info);
  if (/<button\b(?=[^>]*data-pool-update-068="1")[^>]*>[\s\S]*?<\/button>/i.test(html)) {
    html = html.replace(/<button\b(?=[^>]*data-pool-update-068="1")[^>]*>[\s\S]*?<\/button>/i, button);
  } else {
    const normalVersion = /(<span class="ver">[^<]*<\/span>)/;
    const widgetVersion = /(<span class="ps-ver">[^<]*<\/span>)/;
    if (normalVersion.test(html)) html = html.replace(normalVersion, `$1${button}`);
    else if (widgetVersion.test(html)) html = html.replace(widgetVersion, `$1${button}`);
  }
  return html.includes('</head>') ? html.replace('</head>', `${STYLE}</head>`) : `${html}${STYLE}`;
}

function install(adapter) {
  if (!adapter || adapter.__update504Installed) return adapter;
  adapter.__update504Installed = true;

  // inherited updater aus 0.4.x/0.5.0 dauerhaft stilllegen
  adapter.__githubUpdate068Busy = true;

  adapter.__update504Info = {
    availableVersion: '', available: false, running: false,
    status: `Installiert: ${CURRENT}`, error: '', targetVersion: '', remoteSeen: '', source: ''
  };
  adapter.__update504Busy = false;
  adapter.__update504LastCheckTrigger = null;
  adapter.__update504LastInstallTrigger = null;
  adapter.__update504PatchTimer = null;

  async function ensureStates() {
    try { await adapter.setObjectNotExistsAsync('update', { type: 'channel', common: { name: 'GitHub-Update' }, native: {} }); } catch {}
    const definitions = [
      [IDS.installed, 'string', 'info.version', CURRENT, false],
      [IDS.availableVersion, 'string', 'info.version', '', false],
      [IDS.available, 'boolean', 'indicator', false, false],
      [IDS.checkTrigger, 'number', 'value.time', 0, true],
      [IDS.installTrigger, 'number', 'value.time', 0, true],
      [IDS.running, 'boolean', 'indicator.working', false, false],
      [IDS.status, 'string', 'text', `Installiert: ${CURRENT}`, false],
      [IDS.lastCheck, 'number', 'value.time', 0, false],
      [IDS.lastError, 'string', 'text', '', false],
      [IDS.startedAt, 'number', 'value.time', 0, false],
      [IDS.targetVersion, 'string', 'info.version', '', false],
      [IDS.remoteSeen, 'string', 'info.version', '', false],
      [IDS.source, 'string', 'text', '', false]
    ];
    for (const [id, type, role, def, write] of definitions) await adapter.ensureState(id, type, role, def, write);
    await adapter.setStateAsync(IDS.installed, CURRENT, true);
  }

  async function loadInfo() {
    const states = await Promise.all([
      IDS.availableVersion, IDS.available, IDS.running, IDS.status,
      IDS.lastError, IDS.targetVersion, IDS.remoteSeen, IDS.source
    ].map(id => adapter.getStateAsync(id)));
    adapter.__update504Info = {
      availableVersion: cleanVersion(states[0] && states[0].val),
      available: !!(states[1] && states[1].val),
      running: !!(states[2] && states[2].val),
      status: String((states[3] && states[3].val) || `Installiert: ${CURRENT}`),
      error: String((states[4] && states[4].val) || ''),
      targetVersion: cleanVersion(states[5] && states[5].val),
      remoteSeen: cleanVersion(states[6] && states[6].val),
      source: String((states[7] && states[7].val) || '')
    };
  }

  async function writeInfo(changes) {
    Object.assign(adapter.__update504Info, changes);
    const info = adapter.__update504Info;
    await adapter.setStateAsync(IDS.installed, CURRENT, true);
    await adapter.setStateAsync(IDS.availableVersion, info.availableVersion || '', true);
    await adapter.setStateAsync(IDS.available, !!info.available, true);
    await adapter.setStateAsync(IDS.running, !!info.running, true);
    await adapter.setStateAsync(IDS.status, info.status || '', true);
    await adapter.setStateAsync(IDS.lastError, info.error || '', true);
    await adapter.setStateAsync(IDS.targetVersion, info.targetVersion || '', true);
    await adapter.setStateAsync(IDS.remoteSeen, info.remoteSeen || '', true);
    await adapter.setStateAsync(IDS.source, info.source || '', true);
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
        const next = BUTTON_STATES.includes(id)
          ? patchButtonView(current, adapter.namespace, adapter.__update504Info)
          : patchVersion(current);
        if (next && next !== current) await adapter.setStateAsync(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.config.debugMode) {
          adapter.log.debug(`[UPDATE ${CURRENT}] VIS-Patch ${id}: ${error.message || error}`);
        }
      }
    }
  }

  function schedulePatch() {
    if (adapter.__update504PatchTimer || adapter.isShuttingDown) return;
    const timer = setTimeout(async () => {
      adapter.__update504PatchTimer = null;
      try { await patchStates(); } catch {}
    }, 100);
    adapter.__update504PatchTimer = timer;
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  }

  async function check(reason) {
    if (adapter.__update504Busy || adapter.isShuttingDown) return null;
    adapter.__update504Busy = true;
    try {
      await writeInfo({ status: 'Prüfe GitHub auf neue Version …', error: '' });
      const remoteInfo = await readRemoteVersion();
      const remote = remoteInfo.version;
      const available = compareVersions(remote, CURRENT) > 0;
      await writeInfo({
        availableVersion: remote,
        available,
        remoteSeen: remote,
        source: remoteInfo.source,
        status: available
          ? `Update verfügbar: ${CURRENT} → ${remote}`
          : `Version ${CURRENT} ist aktuell`,
        error: '',
        lastCheck: Date.now()
      });
      adapter.log.info(`[UPDATE ${CURRENT}] ${reason}: installiert ${CURRENT}, GitHub ${remote} via ${remoteInfo.source}${available ? ' – Update verfügbar' : ''}`);
      return { remote, available };
    } catch (error) {
      const message = error.message || String(error);
      await writeInfo({
        available: false,
        source: 'error',
        status: 'Update-Prüfung fehlgeschlagen',
        error: message,
        lastCheck: Date.now()
      });
      adapter.log.warn(`[UPDATE ${CURRENT}] ${message}`);
      return null;
    } finally {
      adapter.__update504Busy = false;
    }
  }

  async function consumeHelperResult() {
    const file = resultFile(adapter.namespace);
    if (!fs.existsSync(file)) return;
    let result;
    try { result = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { result = { success: false, stderr: error.message || String(error) }; }
    try { fs.unlinkSync(file); } catch {}
    const target = cleanVersion(result && result.targetVersion);
    const reached = !target || compareVersions(CURRENT, target) >= 0;
    if (result && result.success && reached) {
      await writeInfo({
        running: false, targetVersion: '', available: false,
        availableVersion: CURRENT, remoteSeen: CURRENT,
        status: `Update erfolgreich · Version ${CURRENT}`, error: ''
      });
    } else {
      const detail = result && result.success
        ? `Ziel ${target || '?'} nicht erreicht; installiert ${CURRENT}`
        : String((result && (result.stderr || result.stdout)) || 'Unbekannter Installationsfehler').trim();
      await writeInfo({ running: false, targetVersion: '', status: 'Update fehlgeschlagen', error: detail });
    }
    await adapter.setStateAsync(IDS.startedAt, 0, true);
  }

  async function startUpdate() {
    if (adapter.__update504Info.running || adapter.isShuttingDown) return;
    const result = await check('Prüfung vor Installation');
    if (!result || !result.available) {
      if (result && !result.available) await writeInfo({ status: `Version ${CURRENT} ist bereits aktuell` });
      return;
    }
    const cli = cliInfo();
    if (!cli) {
      await writeInfo({ status: 'Update fehlgeschlagen', error: 'ioBroker-CLI iobroker.js wurde nicht gefunden' });
      return;
    }
    const resultPath = resultFile(adapter.namespace);
    const helperPath = path.join(os.tmpdir(), `iobroker-poolsteuerung-update-${Date.now()}.js`);
    try {
      fs.writeFileSync(helperPath, helperCode(), { encoding: 'utf8', mode: 0o700 });
      try { fs.unlinkSync(resultPath); } catch {}
      await adapter.setStateAsync(IDS.startedAt, Date.now(), true);
      await writeInfo({
        running: true,
        targetVersion: result.remote,
        status: `Update auf ${result.remote} wird installiert …`,
        error: ''
      });
      const child = spawn(process.execPath, [helperPath], {
        cwd: cli.cwd,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          POOL_NODE: process.execPath,
          POOL_CLI: cli.cli,
          POOL_ROOT: cli.cwd,
          POOL_RESULT: resultPath,
          POOL_HELPER: helperPath,
          POOL_TARGET: result.remote,
          POOL_INSTANCE: adapter.namespace
        }
      });
      child.once('error', async error => {
        try { fs.unlinkSync(helperPath); } catch {}
        await adapter.setStateAsync(IDS.startedAt, 0, true);
        await writeInfo({
          running: false, targetVersion: '',
          status: 'Update konnte nicht gestartet werden',
          error: error.message || String(error)
        });
      });
      child.unref();
      adapter.log.warn(`[UPDATE ${CURRENT}] Update auf ${result.remote} gestartet; Adapter wird durch ioBroker neu gestartet.`);
    } catch (error) {
      try { fs.unlinkSync(helperPath); } catch {}
      await adapter.setStateAsync(IDS.startedAt, 0, true);
      await writeInfo({
        running: false, targetVersion: '',
        status: 'Update konnte nicht vorbereitet werden',
        error: error.message || String(error)
      });
    }
  }

  async function pollTriggers() {
    try {
      const [checkState, installState] = await Promise.all([
        adapter.getStateAsync(IDS.checkTrigger),
        adapter.getStateAsync(IDS.installTrigger)
      ]);
      const checkValue = Number(checkState && checkState.val) || 0;
      const installValue = Number(installState && installState.val) || 0;
      if (adapter.__update504LastCheckTrigger === null) adapter.__update504LastCheckTrigger = checkValue;
      if (adapter.__update504LastInstallTrigger === null) adapter.__update504LastInstallTrigger = installValue;

      if (installValue && installValue !== adapter.__update504LastInstallTrigger) {
        adapter.__update504LastInstallTrigger = installValue;
        await startUpdate();
      } else if (checkValue && checkValue !== adapter.__update504LastCheckTrigger) {
        adapter.__update504LastCheckTrigger = checkValue;
        await check('Manuelle VIS-Prüfung');
      }
    } catch {}
  }

  function startPolling() {
    if (adapter.isShuttingDown) return;
    const timer = setTimeout(async () => {
      try { await pollTriggers(); } finally { startPolling(); }
    }, 750);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchButtonView(
      original({ ...(data || {}), adapterVersion: VERSION }),
      adapter.namespace,
      adapter.__update504Info
    );
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
        // alten Updater auch nach dessen ready-Initialisierung wieder blockieren
        adapter.__githubUpdate068Busy = true;
        await ensureStates();
        await loadInfo();
        await consumeHelperResult();
        const [checkState, installState] = await Promise.all([
          adapter.getStateAsync(IDS.checkTrigger),
          adapter.getStateAsync(IDS.installTrigger)
        ]);
        adapter.__update504LastCheckTrigger = Number(checkState && checkState.val) || 0;
        adapter.__update504LastInstallTrigger = Number(installState && installState.val) || 0;
        startPolling();
        await check('Adapterstart');
        const interval = setInterval(() => check('Automatische Minutenprüfung').catch(() => {}), 60000);
        if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
        adapter.log.info(`[UPDATE ${CURRENT}] API-first Updater für Tablet und Mobile aktiv`);
      } catch (error) {
        if (!adapter.isDbClosedError(error)) {
          adapter.log.error(`[UPDATE ${CURRENT}] Initialisierung fehlgeschlagen: ${error.message || error}`);
        }
      }
    }, 3600);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const createBase = require('./main-ipadmini-final-500.js');

let CURRENT = '0.5.6';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}
const VERSION = `v${CURRENT}`;

const REPO = 'radebold/iobroker.poolsteuerung#main';
const RAW_PACKAGE = 'https://raw.githubusercontent.com/radebold/iobroker.poolsteuerung/main/package.json';
const API_PACKAGE = 'https://api.github.com/repos/radebold/iobroker.poolsteuerung/contents/package.json?ref=main';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone'];
const ALL_VIS_STATES = [...VIS_STATES, 'vis.htmlIpadMini'];

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
  source: 'update.checkSource',
  runtimeVersion: 'update.runtimeVersion',
  runtimeStartedAt: 'update.runtimeStartedAt'
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

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(value) {
  return escHtml(value).replace(/\r?\n/g, ' ');
}

function requestText(url, redirects = 0, accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': `ioBroker.poolsteuerung/${CURRENT}`,
        Accept: accept,
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache'
      }
    }, response => {
      const status = Number(response.statusCode) || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 4) return reject(new Error('Zu viele GitHub-Weiterleitungen'));
        return requestText(new URL(response.headers.location, url).toString(), redirects + 1, accept).then(resolve, reject);
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`GitHub HTTP ${status}`));
      }
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 524288) request.destroy(new Error('GitHub-Antwort zu groß'));
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

  // Primär RAW: keine GitHub-API-Rate-Limits.
  try {
    const text = await requestText(`${RAW_PACKAGE}?nocache=${Date.now()}`);
    const pkg = JSON.parse(text);
    const version = cleanVersion(pkg && pkg.version);
    if (!parseVersion(version)) throw new Error(`Ungültige Raw-Version: ${version || 'leer'}`);
    return { version, source: 'github-raw' };
  } catch (error) {
    errors.push(`RAW: ${error.message || error}`);
  }

  // API nur als Fallback.
  try {
    const data = JSON.parse(await requestText(`${API_PACKAGE}&nocache=${Date.now()}`, 0, 'application/vnd.github+json'));
    const decoded = Buffer.from(String(data && data.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
    const pkg = JSON.parse(decoded);
    const version = cleanVersion(pkg && pkg.version);
    if (!parseVersion(version)) throw new Error(`Ungültige API-Version: ${version || 'leer'}`);
    return { version, source: 'github-api-fallback' };
  } catch (error) {
    errors.push(`API: ${error.message || error}`);
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

  // Exakt derselbe VIS-Schreibweg wie beim funktionierenden PoolLab-Button:
  // vis.setValue zuerst, conn.setState als Fallback.
  return escAttr([
    'event.preventDefault()',
    'event.stopPropagation()',
    "var b=this",
    "if(b.dataset.busy==='1')return false",
    "var u=b.dataset.available==='1'",
    `var id=u?'${installId}':'${checkId}'`,
    "if(u&&!confirm('Poolsteuerung auf Version '+(b.dataset.target||'neu')+' aktualisieren?'))return false",
    "var v=null;try{v=window.vis}catch(e){};try{if(!v&&window.parent)v=window.parent.vis}catch(e){};try{if(!v&&window.top)v=window.top.vis}catch(e){}",
    "if(!v){alert('VIS-Verbindung nicht verfügbar');return false}",
    "function w(id,val){try{if(typeof v.setValue==='function')return Promise.resolve(v.setValue(id,val))}catch(e){};try{if(v.conn&&typeof v.conn.setState==='function')return Promise.resolve(v.conn.setState(id,val))}catch(e){};try{if(typeof window.poolSetState==='function')return Promise.resolve(window.poolSetState(id,val))}catch(e){};return Promise.reject(new Error('setState nicht verfügbar'))}",
    "b.dataset.busy='1'",
    "b.textContent=u?'START …':'PRÜFE …'",
    "w(id,Date.now()).then(function(){setTimeout(function(){b.dataset.busy='0'},1200)},function(e){b.dataset.busy='0';alert('Auftrag fehlgeschlagen: '+(e&&e.message?e.message:e))})",
    'return false'
  ].join(';'));
}

const STYLE = `<style data-pool-update-5062="1">
.pool-update-btn{appearance:none!important;position:relative!important;z-index:100!important;pointer-events:auto!important;touch-action:manipulation!important;height:25px;margin-left:8px;padding:0 9px;border:1px solid rgba(255,255,255,.15);border-radius:999px;background:rgba(255,255,255,.07);color:#c5d5e8;font:900 8px/1 Arial;white-space:nowrap;vertical-align:middle;cursor:pointer}
.pool-update-btn.available{background:linear-gradient(135deg,#f59e0b,#e87918);border-color:rgba(255,214,117,.55);color:#fff}.pool-update-btn.running{background:linear-gradient(135deg,#278bd4,#25bfb5);color:#fff;cursor:wait}.pool-update-btn.error{background:rgba(255,107,87,.15);border-color:rgba(255,107,87,.35);color:#ffc0b7}.pool-update-btn:disabled{opacity:.7}.ps-title .pool-update-btn{height:22px;margin-left:5px;padding:0 7px;font-size:7px}.ps-header .pool-update-btn{flex:0 0 auto}
</style>`;

function makeButton(namespace, info) {
  const running = !!info.running;
  const available = !!info.available && compareVersions(info.availableVersion, CURRENT) > 0;
  const hasError = !!info.error && !running;
  const text = running ? 'UPDATE LÄUFT' : available ? `UPDATE ${info.availableVersion}` : hasError ? 'PRÜFEN' : 'AKTUELL';
  const css = running ? 'running' : available ? 'available' : hasError ? 'error' : 'current';
  return `<button type="button" class="pool-update-btn ${css}" data-pool-update-068="1" data-update-5062="1" data-available="${available ? 1 : 0}" data-running="${running ? 1 : 0}" data-target="${escAttr(info.availableVersion || '')}" data-busy="0" title="${escAttr(info.status || `Installiert: ${CURRENT}`)}" onclick="${clickHandler(namespace)}"${running ? ' disabled' : ''}>${escHtml(text)}</button>`;
}

function patchView(value, namespace, info, withButton = true) {
  let html = patchVersion(value);
  if (!html) return html;

  html = html
    .replace(/<style data-pool-update-068="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-502="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-504="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-5062="1">[\s\S]*?<\/style>/g, '');

  if (!withButton) return html;

  const button = makeButton(namespace, info);
  const existing = /<button\b(?=[^>]*data-pool-update-068="1")[^>]*>[\s\S]*?<\/button>/i;
  if (existing.test(html)) {
    html = html.replace(existing, button);
  } else {
    const normal = /(<span class="ver">[^<]*<\/span>)/;
    const widget = /(<span class="ps-ver">[^<]*<\/span>)/;
    if (normal.test(html)) html = html.replace(normal, `$1${button}`);
    else if (widget.test(html)) html = html.replace(widget, `$1${button}`);
  }

  return html.includes('</head>') ? html.replace('</head>', `${STYLE}</head>`) : `${html}${STYLE}`;
}

function install(adapter) {
  if (!adapter || adapter.__update5062Installed) return adapter;
  adapter.__update5062Installed = true;

  // Alten 0.4.68-Updater dauerhaft blockieren. Seine 5-Minuten-Trigger aus 0.4.70 sind harmlos
  // und werden von dieser Runtime als normale Prüfanfrage verarbeitet.
  adapter.__githubUpdate068Busy = true;

  const info = {
    availableVersion: '',
    available: false,
    running: false,
    status: `Installiert: ${CURRENT}`,
    error: '',
    targetVersion: '',
    remoteSeen: '',
    source: 'runtime-starting'
  };

  let checking = false;
  let lastCheckTrigger = null;
  let lastInstallTrigger = null;
  let renderTimer = null;
  let booted = false;

  async function ensureState(id, type, role, def, write) {
    await adapter.ensureState(id, type, role, def, write);
  }

  async function ensureStates() {
    try { await adapter.setObjectNotExistsAsync('update', { type: 'channel', common: { name: 'GitHub-Update' }, native: {} }); } catch {}
    await ensureState(IDS.installed, 'string', 'info.version', CURRENT, false);
    await ensureState(IDS.availableVersion, 'string', 'info.version', '', false);
    await ensureState(IDS.available, 'boolean', 'indicator', false, false);
    await ensureState(IDS.checkTrigger, 'number', 'value.time', 0, true);
    await ensureState(IDS.installTrigger, 'number', 'value.time', 0, true);
    await ensureState(IDS.running, 'boolean', 'indicator.working', false, false);
    await ensureState(IDS.status, 'string', 'text', `Installiert: ${CURRENT}`, false);
    await ensureState(IDS.lastCheck, 'number', 'value.time', 0, false);
    await ensureState(IDS.lastError, 'string', 'text', '', false);
    await ensureState(IDS.startedAt, 'number', 'value.time', 0, false);
    await ensureState(IDS.targetVersion, 'string', 'info.version', '', false);
    await ensureState(IDS.remoteSeen, 'string', 'info.version', '', false);
    await ensureState(IDS.source, 'string', 'text', '', false);
    await ensureState(IDS.runtimeVersion, 'string', 'info.version', CURRENT, false);
    await ensureState(IDS.runtimeStartedAt, 'number', 'value.time', 0, false);
  }

  async function loadInfo() {
    const states = await Promise.all([
      IDS.availableVersion, IDS.available, IDS.running, IDS.status,
      IDS.lastError, IDS.targetVersion, IDS.remoteSeen, IDS.source
    ].map(id => adapter.getStateAsync(id)));
    info.availableVersion = cleanVersion(states[0] && states[0].val);
    info.available = !!(states[1] && states[1].val);
    info.running = !!(states[2] && states[2].val);
    info.status = String((states[3] && states[3].val) || `Installiert: ${CURRENT}`);
    info.error = String((states[4] && states[4].val) || '');
    info.targetVersion = cleanVersion(states[5] && states[5].val);
    info.remoteSeen = cleanVersion(states[6] && states[6].val);
    info.source = String((states[7] && states[7].val) || '');
  }

  function scheduleRender() {
    if (renderTimer || adapter.isShuttingDown) return;
    const timer = setTimeout(async () => {
      renderTimer = null;
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
        await patchExistingStates();
      } catch {}
    }, 120);
    renderTimer = timer;
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  }

  async function writeInfo(changes) {
    Object.assign(info, changes);
    const pairs = [
      [IDS.installed, CURRENT],
      [IDS.availableVersion, info.availableVersion || ''],
      [IDS.available, !!info.available],
      [IDS.running, !!info.running],
      [IDS.status, info.status || ''],
      [IDS.lastError, info.error || ''],
      [IDS.targetVersion, info.targetVersion || ''],
      [IDS.remoteSeen, info.remoteSeen || ''],
      [IDS.source, info.source || ''],
      [IDS.runtimeVersion, CURRENT]
    ];
    for (const [id, value] of pairs) await adapter.setStateAsync(id, value, true);
    if (Object.prototype.hasOwnProperty.call(changes, 'lastCheck')) await adapter.setStateAsync(IDS.lastCheck, Number(changes.lastCheck) || 0, true);
    scheduleRender();
  }

  async function patchExistingStates() {
    for (const id of ALL_VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = patchView(current, adapter.namespace, info, VIS_STATES.includes(id));
        if (next && next !== current) await adapter.setStateAsync(id, next, true);
      } catch {}
    }
  }

  async function check(reason) {
    if (checking || adapter.isShuttingDown) return null;
    checking = true;
    try {
      await writeInfo({ status: 'Prüfe GitHub auf neue Version …', error: '', source: 'github-raw:checking' });
      const remote = await readRemoteVersion();
      const available = compareVersions(remote.version, CURRENT) > 0;
      await writeInfo({
        availableVersion: remote.version,
        available,
        remoteSeen: remote.version,
        source: remote.source,
        status: available ? `Update verfügbar: ${CURRENT} → ${remote.version}` : `Version ${CURRENT} ist aktuell`,
        error: '',
        lastCheck: Date.now()
      });
      adapter.log.info(`[UPDATE ${CURRENT}] ${reason}: GitHub ${remote.version} via ${remote.source}${available ? ' – Update verfügbar' : ''}`);
      return { remote: remote.version, available };
    } catch (error) {
      const message = error.message || String(error);
      await writeInfo({ available: false, source: 'error', status: 'Update-Prüfung fehlgeschlagen', error: message, lastCheck: Date.now() });
      adapter.log.warn(`[UPDATE ${CURRENT}] Prüfung fehlgeschlagen: ${message}`);
      return null;
    } finally {
      checking = false;
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
      await writeInfo({ running: false, targetVersion: '', available: false, availableVersion: CURRENT, remoteSeen: CURRENT, status: `Update erfolgreich · Version ${CURRENT}`, error: '' });
    } else {
      const detail = result && result.success
        ? `Ziel ${target || '?'} nicht erreicht; installiert ${CURRENT}`
        : String((result && (result.stderr || result.stdout)) || 'Unbekannter Installationsfehler').trim();
      await writeInfo({ running: false, targetVersion: '', status: 'Update fehlgeschlagen', error: detail });
    }
    await adapter.setStateAsync(IDS.startedAt, 0, true);
  }

  async function startUpdate() {
    if (info.running || adapter.isShuttingDown) return;
    const result = await check('Prüfung vor Installation');
    if (!result || !result.available) return;

    const cli = cliInfo();
    if (!cli) {
      await writeInfo({ status: 'Update fehlgeschlagen', error: 'ioBroker-CLI iobroker.js wurde nicht gefunden' });
      return;
    }

    const helperPath = path.join(os.tmpdir(), `iobroker-poolsteuerung-update-${Date.now()}.js`);
    const resultPath = resultFile(adapter.namespace);
    try {
      fs.writeFileSync(helperPath, helperCode(), { encoding: 'utf8', mode: 0o700 });
      try { fs.unlinkSync(resultPath); } catch {}
      await adapter.setStateAsync(IDS.startedAt, Date.now(), true);
      await writeInfo({ running: true, targetVersion: result.remote, status: `Update auf ${result.remote} wird installiert …`, error: '' });

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
      child.unref();
      adapter.log.warn(`[UPDATE ${CURRENT}] Update auf ${result.remote} gestartet; Adapter wird durch ioBroker neu gestartet.`);
    } catch (error) {
      try { fs.unlinkSync(helperPath); } catch {}
      await adapter.setStateAsync(IDS.startedAt, 0, true);
      await writeInfo({ running: false, targetVersion: '', status: 'Update konnte nicht gestartet werden', error: error.message || String(error) });
    }
  }

  async function pollTriggers() {
    try {
      // Alten Updater weiterhin blockieren.
      adapter.__githubUpdate068Busy = true;
      const [checkState, installState] = await Promise.all([
        adapter.getStateAsync(IDS.checkTrigger),
        adapter.getStateAsync(IDS.installTrigger)
      ]);
      const checkValue = Number(checkState && checkState.val) || 0;
      const installValue = Number(installState && installState.val) || 0;

      if (lastCheckTrigger === null) lastCheckTrigger = checkValue;
      if (lastInstallTrigger === null) lastInstallTrigger = installValue;

      if (installValue && installValue !== lastInstallTrigger) {
        lastInstallTrigger = installValue;
        await startUpdate();
      } else if (checkValue && checkValue !== lastCheckTrigger) {
        lastCheckTrigger = checkValue;
        await check('VIS-Prüfung');
      }
    } catch {}
  }

  function startPollLoop() {
    if (adapter.isShuttingDown) return;
    const timer = setTimeout(async () => {
      try { await pollTriggers(); } finally { startPollLoop(); }
    }, 500);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchView(original({ ...(data || {}), adapterVersion: VERSION }), adapter.namespace, info, true);
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
    if (booted || adapter.isShuttingDown) return;
    try {
      adapter.__githubUpdate068Busy = true;
      await ensureStates();
      await loadInfo();
      await adapter.setStateAsync(IDS.runtimeVersion, CURRENT, true);
      await adapter.setStateAsync(IDS.runtimeStartedAt, Date.now(), true);
      await consumeHelperResult();

      const [checkState, installState] = await Promise.all([
        adapter.getStateAsync(IDS.checkTrigger),
        adapter.getStateAsync(IDS.installTrigger)
      ]);
      lastCheckTrigger = Number(checkState && checkState.val) || 0;
      lastInstallTrigger = Number(installState && installState.val) || 0;

      booted = true;
      startPollLoop();
      await check('Adapterstart');
      const interval = setInterval(() => check('Automatische 5-Minuten-Prüfung').catch(() => {}), CHECK_INTERVAL_MS);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
      await patchExistingStates();
      adapter.log.info(`[UPDATE ${CURRENT}] konsolidierter Updater aktiv: RAW zuerst, API nur Fallback, Prüfung alle 5 Minuten`);
    } catch (error) {
      const timer = setTimeout(() => boot().catch(() => {}), 1500);
      if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
    }
  }

  const starter = setTimeout(() => boot().catch(() => {}), 1800);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(starter);

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

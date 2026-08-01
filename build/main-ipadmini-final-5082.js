'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn, execFile } = require('node:child_process');
const createBase = require('./main-ipadmini-final-500.js');

let CURRENT = '0.5.8';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}
const VERSION = `v${CURRENT}`;

const REPO = 'radebold/iobroker.poolsteuerung#main';
const GIT_REMOTE = 'https://github.com/radebold/iobroker.poolsteuerung.git';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone'];
const ALL_VIS_STATES = [...VIS_STATES, 'vis.htmlIpadMini'];
const AUTO_CHECK_MS = 60 * 1000;

const IDS = {
  installed: 'update.installedVersion',
  availableVersion: 'update.availableVersion',
  available: 'update.available',
  checkNow: 'update.checkNow',
  installNow: 'update.installNow',
  running: 'update.running',
  status: 'update.status',
  lastCheck: 'update.lastCheck',
  lastError: 'update.lastError',
  startedAt: 'update.startedAt',
  targetVersion: 'update.targetVersion',
  remoteSeen: 'update.remoteVersionSeen',
  source: 'update.checkSource',
  runtimeVersion: 'update.runtimeVersion',
  runtimeStartedAt: 'update.runtimeStartedAt',
  releaseNotes: 'update.releaseNotes',
  headCommit: 'update.headCommit'
};

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function parseVersion(value) {
  const m = cleanVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]([\w.-]+))?$/);
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], s: m[4] || '' } : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.n[i] !== right.n[i]) return left.n[i] > right.n[i] ? 1 : -1;
  }
  if (left.s === right.s) return 0;
  if (!left.s) return 1;
  if (!right.s) return -1;
  return left.s.localeCompare(right.s, undefined, { numeric: true, sensitivity: 'base' });
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

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function requestText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': `ioBroker.poolsteuerung/${CURRENT}`,
        Accept: 'application/json,text/plain,*/*',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache'
      }
    }, res => {
      const status = Number(res.statusCode) || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('Zu viele Weiterleitungen'));
        return requestText(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (text.length > 262144) req.destroy(new Error('Manifest zu groß'));
      });
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
  });
}

function readMainSha() {
  return new Promise((resolve, reject) => {
    execFile('git', ['ls-remote', GIT_REMOTE, 'refs/heads/main'], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`git ls-remote fehlgeschlagen: ${String(stderr || error.message || error).trim()}`));
      const m = String(stdout || '').match(/^([0-9a-f]{40})\s+refs\/heads\/main/im);
      if (!m) return reject(new Error('main-Commit konnte nicht aus git ls-remote gelesen werden'));
      resolve(m[1].toLowerCase());
    });
  });
}

async function readReleaseAtSha(sha) {
  const sources = [
    ['github-raw-sha', `https://raw.githubusercontent.com/radebold/iobroker.poolsteuerung/${sha}/releases/latest.json`],
    ['jsdelivr-sha', `https://cdn.jsdelivr.net/gh/radebold/iobroker.poolsteuerung@${sha}/releases/latest.json`]
  ];
  const errors = [];
  for (const [source, url] of sources) {
    try {
      const manifest = JSON.parse(await requestText(`${url}?t=${Date.now()}`));
      const version = cleanVersion(manifest && manifest.version);
      if (!parseVersion(version)) throw new Error(`Ungültige Version: ${version || 'leer'}`);
      return {
        version,
        notes: String((manifest && manifest.notes) || ''),
        source: `${source}:${sha.slice(0, 8)}`,
        sha,
        manifest
      };
    } catch (error) {
      errors.push(`${source}: ${error.message || error}`);
    }
  }
  throw new Error(errors.join(' | ') || 'Release-Manifest konnte nicht gelesen werden');
}

async function readFreshRelease() {
  const sha = await readMainSha();
  return readReleaseAtSha(sha);
}

function cliInfo() {
  for (const cli of [
    path.resolve(__dirname, '../../../iobroker.js'),
    path.resolve(process.cwd(), 'iobroker.js'),
    '/opt/iobroker/iobroker.js'
  ]) {
    try { if (fs.statSync(cli).isFile()) return { cli, cwd: path.dirname(cli) }; } catch {}
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

const STYLE = `<style data-pool-update-single-5082="1">
.pool-update-btn{appearance:none!important;position:relative!important;z-index:100!important;pointer-events:auto!important;touch-action:manipulation!important;height:25px;margin-left:8px;padding:0 9px;border:1px solid rgba(255,255,255,.15);border-radius:999px;background:rgba(255,255,255,.07);color:#c5d5e8;font:900 8px/1 Arial;white-space:nowrap;vertical-align:middle;cursor:pointer}.pool-update-btn.available{background:linear-gradient(135deg,#f59e0b,#e87918);border-color:rgba(255,214,117,.55);color:#fff}.pool-update-btn.running{background:linear-gradient(135deg,#278bd4,#25bfb5);color:#fff;cursor:wait}.pool-update-btn.error{background:rgba(255,107,87,.15);border-color:rgba(255,107,87,.35);color:#ffc0b7}.pool-update-btn:disabled{opacity:.7}.ps-title .pool-update-btn{height:22px;margin-left:5px;padding:0 7px;font-size:7px}.ps-header .pool-update-btn{flex:0 0 auto}
</style>`;

function clickHandler(namespace) {
  const checkId = `${namespace}.${IDS.checkNow}`.replace(/'/g, "\\'");
  const installId = `${namespace}.${IDS.installNow}`.replace(/'/g, "\\'");
  return escAttr([
    'event.preventDefault()',
    'event.stopPropagation()',
    'var b=this',
    "if(b.dataset.busy==='1')return false",
    "var u=b.dataset.available==='1'",
    `var id=u?'${installId}':'${checkId}'`,
    "if(u&&!confirm('Poolsteuerung auf Version '+(b.dataset.target||'neu')+' aktualisieren?'))return false",
    "var v=null;try{v=window.vis}catch(e){};try{if(!v&&window.parent)v=window.parent.vis}catch(e){};try{if(!v&&window.top)v=window.top.vis}catch(e){}",
    "if(!v){alert('VIS-Verbindung nicht verfügbar');return false}",
    "function w(id,val){if(typeof v.setValue==='function')return Promise.resolve(v.setValue(id,val));if(v.conn&&typeof v.conn.setState==='function')return Promise.resolve(v.conn.setState(id,val));return Promise.reject(new Error('setState nicht verfügbar'))}",
    "b.dataset.busy='1'",
    "b.textContent=u?'START …':'PRÜFE …'",
    "w(id,true).then(function(){setTimeout(function(){b.dataset.busy='0'},1200)},function(e){b.dataset.busy='0';alert('Auftrag fehlgeschlagen: '+(e&&e.message?e.message:e))})",
    'return false'
  ].join(';'));
}

function makeButton(namespace, info) {
  const running = !!info.running;
  const available = !!info.available && compareVersions(info.availableVersion, CURRENT) > 0;
  const error = !!info.error && !running;
  const text = running ? 'UPDATE LÄUFT' : available ? `UPDATE ${info.availableVersion}` : error ? 'PRÜFEN' : 'AKTUELL';
  const css = running ? 'running' : available ? 'available' : error ? 'error' : 'current';
  return `<button type="button" class="pool-update-btn ${css}" data-pool-update-single="1" data-available="${available ? 1 : 0}" data-running="${running ? 1 : 0}" data-target="${escAttr(info.availableVersion || '')}" data-busy="0" title="${escAttr(info.status || `Installiert: ${CURRENT}`)}" onclick="${clickHandler(namespace)}"${running ? ' disabled' : ''}>${escHtml(text)}</button>`;
}

function patchView(value, namespace, info, withButton = true) {
  let html = patchVersion(value);
  if (!html) return html;
  html = html
    .replace(/<style data-pool-update-068="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-502="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-504="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-5062="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-manifest-5063="1">[\s\S]*?<\/style>/g, '')
    .replace(/<style data-pool-update-single-5082="1">[\s\S]*?<\/style>/g, '');
  if (!withButton) return html;
  const button = makeButton(namespace, info);
  const existing = /<button\b(?=[^>]*(?:data-pool-update-068|data-pool-update-manifest|data-pool-update-single)=)[^>]*>[\s\S]*?<\/button>/i;
  if (existing.test(html)) html = html.replace(existing, button);
  else {
    const normal = /(<span class="ver">[^<]*<\/span>)/;
    const widget = /(<span class="ps-ver">[^<]*<\/span>)/;
    if (normal.test(html)) html = html.replace(normal, `$1${button}`);
    else if (widget.test(html)) html = html.replace(widget, `$1${button}`);
  }
  return html.includes('</head>') ? html.replace('</head>', `${STYLE}</head>`) : `${html}${STYLE}`;
}

function install(adapter) {
  if (!adapter || adapter.__singleUpdater5082Installed) return adapter;
  adapter.__singleUpdater5082Installed = true;

  // Den geerbten 0.4.68-Updater aus der 0.5.0-Basis dauerhaft sperren.
  adapter.__githubUpdate068Busy = true;

  const info = {
    availableVersion: '', available: false, running: false,
    status: `Installiert: ${CURRENT}`, error: '', targetVersion: '',
    remoteSeen: '', source: 'starting', notes: '', headCommit: ''
  };
  let checking = false;
  let updating = false;
  let renderTimer = null;
  let booted = false;

  async function ensureObject(id, common) {
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
  }

  async function ensureStates() {
    try { await adapter.setObjectNotExistsAsync('update', { type: 'channel', common: { name: 'GitHub-Update' }, native: {} }); } catch {}
    await ensureObject(IDS.checkNow, { name: 'Jetzt nach Update suchen', type: 'boolean', role: 'button', read: true, write: true, def: false });
    await ensureObject(IDS.installNow, { name: 'Verfügbares Update installieren', type: 'boolean', role: 'button', read: true, write: true, def: false });
    await ensureObject(IDS.installed, { name: 'Installierte Adapterversion', type: 'string', role: 'info.version', read: true, write: false, def: CURRENT });
    await ensureObject(IDS.availableVersion, { name: 'Verfügbare Version', type: 'string', role: 'info.version', read: true, write: false, def: '' });
    await ensureObject(IDS.available, { name: 'Update verfügbar', type: 'boolean', role: 'indicator', read: true, write: false, def: false });
    await ensureObject(IDS.running, { name: 'Update läuft', type: 'boolean', role: 'indicator.working', read: true, write: false, def: false });
    await ensureObject(IDS.status, { name: 'Update-Status', type: 'string', role: 'text', read: true, write: false, def: '' });
    await ensureObject(IDS.lastCheck, { name: 'Letzte Update-Prüfung', type: 'number', role: 'value.time', read: true, write: false, def: 0 });
    await ensureObject(IDS.lastError, { name: 'Letzter Update-Fehler', type: 'string', role: 'text', read: true, write: false, def: '' });
    await ensureObject(IDS.startedAt, { name: 'Update gestartet am', type: 'number', role: 'value.time', read: true, write: false, def: 0 });
    await ensureObject(IDS.targetVersion, { name: 'Zielversion des Updates', type: 'string', role: 'info.version', read: true, write: false, def: '' });
    await ensureObject(IDS.remoteSeen, { name: 'Gelesene Remote-Version', type: 'string', role: 'info.version', read: true, write: false, def: '' });
    await ensureObject(IDS.source, { name: 'Quelle der Update-Prüfung', type: 'string', role: 'text', read: true, write: false, def: '' });
    await ensureObject(IDS.runtimeVersion, { name: 'Aktive Update-Runtime', type: 'string', role: 'info.version', read: true, write: false, def: CURRENT });
    await ensureObject(IDS.runtimeStartedAt, { name: 'Update-Runtime gestartet am', type: 'number', role: 'value.time', read: true, write: false, def: 0 });
    await ensureObject(IDS.releaseNotes, { name: 'Release-Hinweise', type: 'string', role: 'text', read: true, write: false, def: '' });
    await ensureObject(IDS.headCommit, { name: 'Aktueller main-Commit', type: 'string', role: 'text', read: true, write: false, def: '' });
    await adapter.setStateAsync(IDS.checkNow, false, true);
    await adapter.setStateAsync(IDS.installNow, false, true);
  }

  async function loadInfo() {
    const states = await Promise.all([
      IDS.availableVersion, IDS.available, IDS.running, IDS.status, IDS.lastError,
      IDS.targetVersion, IDS.remoteSeen, IDS.source, IDS.releaseNotes, IDS.headCommit
    ].map(id => adapter.getStateAsync(id)));
    info.availableVersion = cleanVersion(states[0] && states[0].val);
    info.available = !!(states[1] && states[1].val);
    info.running = !!(states[2] && states[2].val);
    info.status = String((states[3] && states[3].val) || `Installiert: ${CURRENT}`);
    info.error = String((states[4] && states[4].val) || '');
    info.targetVersion = cleanVersion(states[5] && states[5].val);
    info.remoteSeen = cleanVersion(states[6] && states[6].val);
    info.source = String((states[7] && states[7].val) || '');
    info.notes = String((states[8] && states[8].val) || '');
    info.headCommit = String((states[9] && states[9].val) || '');
  }

  function scheduleRender() {
    if (renderTimer || adapter.isShuttingDown) return;
    renderTimer = setTimeout(async () => {
      renderTimer = null;
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
        await patchExistingStates();
      } catch {}
    }, 150);
    if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(renderTimer);
  }

  async function writeInfo(changes) {
    Object.assign(info, changes);
    const pairs = [
      [IDS.installed, CURRENT],
      [IDS.runtimeVersion, CURRENT],
      [IDS.availableVersion, info.availableVersion || ''],
      [IDS.available, !!info.available],
      [IDS.running, !!info.running],
      [IDS.status, info.status || ''],
      [IDS.lastError, info.error || ''],
      [IDS.targetVersion, info.targetVersion || ''],
      [IDS.remoteSeen, info.remoteSeen || ''],
      [IDS.source, info.source || ''],
      [IDS.releaseNotes, info.notes || ''],
      [IDS.headCommit, info.headCommit || '']
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
      await writeInfo({ status: 'Prüfe auf neue Version …', error: '', source: 'git-ls-remote:checking' });
      const release = await readFreshRelease();
      const available = compareVersions(release.version, CURRENT) > 0;
      await writeInfo({
        availableVersion: release.version,
        available,
        remoteSeen: release.version,
        source: release.source,
        notes: release.notes,
        headCommit: release.sha,
        status: available ? `Update verfügbar: ${CURRENT} → ${release.version}` : `Version ${CURRENT} ist aktuell`,
        error: '',
        lastCheck: Date.now()
      });
      adapter.log.info(`[UPDATE ${CURRENT}] ${reason}: ${release.version} via ${release.source}`);
      return { remote: release.version, available };
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
      await writeInfo({ running: false, targetVersion: '', available: false, status: `Update erfolgreich · Version ${CURRENT}`, error: '' });
    } else {
      const detail = result && result.success
        ? `Ziel ${target || '?'} nicht erreicht; installiert ${CURRENT}`
        : String((result && (result.stderr || result.stdout)) || 'Unbekannter Installationsfehler').trim();
      await writeInfo({ running: false, targetVersion: '', status: 'Update fehlgeschlagen', error: detail });
    }
    await adapter.setStateAsync(IDS.startedAt, 0, true);
  }

  async function startUpdate() {
    if (updating || adapter.isShuttingDown) return;
    updating = true;
    try {
      const result = await check('Prüfung vor Installation');
      if (!result || !result.available) return;
      const cli = cliInfo();
      if (!cli) {
        await writeInfo({ status: 'Update fehlgeschlagen', error: 'ioBroker-CLI iobroker.js wurde nicht gefunden' });
        return;
      }
      const helperPath = path.join(os.tmpdir(), `iobroker-poolsteuerung-update-${Date.now()}.js`);
      const resultPath = resultFile(adapter.namespace);
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
      adapter.log.warn(`[UPDATE ${CURRENT}] Installation ${CURRENT} → ${result.remote} gestartet.`);
    } catch (error) {
      await adapter.setStateAsync(IDS.startedAt, 0, true).catch(() => {});
      await writeInfo({ running: false, targetVersion: '', status: 'Update konnte nicht gestartet werden', error: error.message || String(error) });
    } finally {
      updating = false;
    }
  }

  async function pollButtons() {
    adapter.__githubUpdate068Busy = true;
    try {
      const [checkState, installState] = await Promise.all([
        adapter.getStateAsync(IDS.checkNow),
        adapter.getStateAsync(IDS.installNow)
      ]);
      if (checkState && checkState.val === true) {
        await adapter.setStateAsync(IDS.checkNow, false, true);
        await check('Manueller Button');
      }
      if (installState && installState.val === true) {
        await adapter.setStateAsync(IDS.installNow, false, true);
        await startUpdate();
      }
    } catch {}
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
      booted = true;
      const buttonPoll = setInterval(() => pollButtons().catch(() => {}), 300);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(buttonPoll);
      const guard = setInterval(() => { adapter.__githubUpdate068Busy = true; }, 1000);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(guard);
      const auto = setInterval(() => check('Automatische Minutenprüfung').catch(() => {}), AUTO_CHECK_MS);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(auto);
      await check('Adapterstart');
      await patchExistingStates();
      adapter.log.info(`[UPDATE ${CURRENT}] Einzel-Updater 5082 aktiv: git ls-remote → Manifest@SHA; checkNow/installNow.`);
    } catch (error) {
      adapter.log.warn(`[UPDATE ${CURRENT}] Start fehlgeschlagen: ${error.message || error}`);
      const retry = setTimeout(() => boot().catch(() => {}), 1500);
      if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(retry);
    }
  }

  const starter = setTimeout(() => boot().catch(() => {}), 2200);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(starter);
  return adapter;
}

function createAdapter(options = {}) {
  const adapter = createBase(options);
  adapter.__githubUpdate068Busy = true;
  return install(adapter);
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

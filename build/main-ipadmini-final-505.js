'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const createBase = require('./main-ipadmini-final-504.js');

let CURRENT = '0.5.5';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}

const REPO = 'radebold/iobroker.poolsteuerung#main';
const API_COMMIT = 'https://api.github.com/repos/radebold/iobroker.poolsteuerung/commits/main';
const API_CONTENT = 'https://api.github.com/repos/radebold/iobroker.poolsteuerung/contents/package.json';

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

function requestJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': `ioBroker.poolsteuerung/${CURRENT}`,
        Accept: 'application/vnd.github+json',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache'
      }
    }, response => {
      const status = Number(response.statusCode) || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 4) return reject(new Error('Zu viele GitHub-Weiterleitungen'));
        return requestJson(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
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
      response.on('end', () => {
        try { resolve(JSON.parse(text)); }
        catch (error) { reject(new Error(`Ungültige GitHub-JSON-Antwort: ${error.message || error}`)); }
      });
      response.on('error', reject);
    });
    request.setTimeout(15000, () => request.destroy(new Error('GitHub-Zeitüberschreitung')));
    request.on('error', reject);
  });
}

async function readRemoteVersion() {
  const commit = await requestJson(`${API_COMMIT}?ts=${Date.now()}`);
  const sha = String(commit && commit.sha || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('GitHub lieferte keinen gültigen main-Commit-SHA');

  const data = await requestJson(`${API_CONTENT}?ref=${encodeURIComponent(sha)}&ts=${Date.now()}`);
  const decoded = Buffer.from(String(data && data.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
  const pkg = JSON.parse(decoded);
  const version = cleanVersion(pkg && pkg.version);
  if (!parseVersion(version)) throw new Error(`Ungültige GitHub-Version: ${version || 'leer'}`);
  return { version, source: `github-commit-api:${sha.slice(0, 8)}`, sha };
}

function cliInfo() {
  const candidates = [
    path.resolve(__dirname, '../../../iobroker.js'),
    path.resolve(process.cwd(), 'iobroker.js'),
    '/opt/iobroker/iobroker.js'
  ];
  for (const cli of candidates) {
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

function install(adapter) {
  if (!adapter || adapter.__update505Installed) return adapter;
  adapter.__update505Installed = true;

  // Alle geerbten Update-Prüfer blockieren. Die 0.5.5-Runtime übernimmt vollständig.
  adapter.__githubUpdate068Busy = true;
  adapter.__update501Busy = true;
  adapter.__update502Busy = true;
  adapter.__update504Busy = true;

  let booted = false;
  let bootAttempts = 0;
  let checking = false;
  let lastCheckTrigger = null;
  let lastInstallTrigger = null;
  let pollTimer = null;
  let checkInterval = null;
  let renderTimer = null;

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

  async function ensureState(id, name, type, role, def, write) {
    try {
      await adapter.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, type, role, read: true, write: !!write, def },
        native: {}
      });
    } catch {}
  }

  async function ensureStates() {
    try {
      await adapter.setObjectNotExistsAsync('update', { type: 'channel', common: { name: 'GitHub-Update' }, native: {} });
    } catch {}
    await ensureState(IDS.installed, 'Installierte Adapterversion', 'string', 'info.version', CURRENT, false);
    await ensureState(IDS.availableVersion, 'Auf GitHub verfügbare Version', 'string', 'info.version', '', false);
    await ensureState(IDS.available, 'Update verfügbar', 'boolean', 'indicator', false, false);
    await ensureState(IDS.checkTrigger, 'Jetzt nach Update suchen', 'number', 'value.time', 0, true);
    await ensureState(IDS.installTrigger, 'GitHub-Update installieren', 'number', 'value.time', 0, true);
    await ensureState(IDS.running, 'Update läuft', 'boolean', 'indicator.working', false, false);
    await ensureState(IDS.status, 'Update-Status', 'string', 'text', `Installiert: ${CURRENT}`, false);
    await ensureState(IDS.lastCheck, 'Letzte Update-Prüfung', 'number', 'value.time', 0, false);
    await ensureState(IDS.lastError, 'Letzter Update-Fehler', 'string', 'text', '', false);
    await ensureState(IDS.startedAt, 'Update gestartet am', 'number', 'value.time', 0, false);
    await ensureState(IDS.targetVersion, 'Zielversion des Updates', 'string', 'info.version', '', false);
    await ensureState(IDS.remoteSeen, 'Von GitHub gelesene Version', 'string', 'info.version', '', false);
    await ensureState(IDS.source, 'Quelle der Update-Prüfung', 'string', 'text', '', false);
    await ensureState(IDS.runtimeVersion, 'Aktive Update-Runtime', 'string', 'info.version', CURRENT, false);
    await ensureState(IDS.runtimeStartedAt, 'Update-Runtime gestartet am', 'number', 'value.time', 0, false);
  }

  function syncInheritedInfo() {
    if (adapter.__update504Info) {
      Object.assign(adapter.__update504Info, {
        availableVersion: info.availableVersion,
        available: info.available,
        running: info.running,
        status: info.status,
        error: info.error,
        targetVersion: info.targetVersion,
        remoteSeen: info.remoteSeen,
        source: info.source
      });
    }
  }

  function scheduleRender() {
    if (renderTimer || adapter.isShuttingDown) return;
    renderTimer = setTimeout(async () => {
      renderTimer = null;
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
      } catch {}
    }, 120);
  }

  async function writeInfo(changes) {
    Object.assign(info, changes);
    syncInheritedInfo();
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
    if (Object.prototype.hasOwnProperty.call(changes, 'lastCheck')) {
      await adapter.setStateAsync(IDS.lastCheck, Number(changes.lastCheck) || 0, true);
    }
    scheduleRender();
  }

  async function check(reason) {
    if (checking || adapter.isShuttingDown) return null;
    checking = true;
    try {
      await writeInfo({ status: 'Prüfe GitHub auf neue Version …', error: '', source: 'github-commit-api:checking' });
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
      await writeInfo({
        available: false,
        source: 'error',
        status: 'Update-Prüfung fehlgeschlagen',
        error: message,
        lastCheck: Date.now()
      });
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
      await writeInfo({
        running: false,
        targetVersion: '',
        available: false,
        availableVersion: CURRENT,
        remoteSeen: CURRENT,
        status: `Update erfolgreich · Version ${CURRENT}`,
        error: ''
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
        await writeInfo({ running: false, targetVersion: '', status: 'Update konnte nicht gestartet werden', error: error.message || String(error) });
      });
      child.unref();
      adapter.log.warn(`[UPDATE ${CURRENT}] Installation von ${result.remote} gestartet.`);
    } catch (error) {
      try { fs.unlinkSync(helperPath); } catch {}
      await adapter.setStateAsync(IDS.startedAt, 0, true);
      await writeInfo({ running: false, targetVersion: '', status: 'Update konnte nicht vorbereitet werden', error: error.message || String(error) });
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
      if (lastCheckTrigger === null) lastCheckTrigger = checkValue;
      if (lastInstallTrigger === null) lastInstallTrigger = installValue;

      if (installValue && installValue !== lastInstallTrigger) {
        lastInstallTrigger = installValue;
        await startUpdate();
      } else if (checkValue && checkValue !== lastCheckTrigger) {
        lastCheckTrigger = checkValue;
        await check('Manuelle VIS-Prüfung');
      }
    } catch {}
  }

  function startPolling() {
    if (pollTimer || adapter.isShuttingDown) return;
    const loop = async () => {
      pollTimer = null;
      try { await pollTriggers(); } catch {}
      if (!adapter.isShuttingDown) pollTimer = setTimeout(loop, 750);
    };
    pollTimer = setTimeout(loop, 750);
  }

  async function bootstrap(reason) {
    if (booted || adapter.isShuttingDown) return;
    bootAttempts += 1;
    try {
      await ensureStates();
      await adapter.setStateAsync(IDS.runtimeVersion, CURRENT, true);
      await adapter.setStateAsync(IDS.runtimeStartedAt, Date.now(), true);
      await adapter.setStateAsync(IDS.source, 'runtime-started', true);
      await adapter.setStateAsync(IDS.installed, CURRENT, true);

      const [checkState, installState] = await Promise.all([
        adapter.getStateAsync(IDS.checkTrigger),
        adapter.getStateAsync(IDS.installTrigger)
      ]);
      lastCheckTrigger = Number(checkState && checkState.val) || 0;
      lastInstallTrigger = Number(installState && installState.val) || 0;

      booted = true;
      await consumeHelperResult();
      startPolling();
      await check(`Runtime-Start (${reason})`);
      checkInterval = setInterval(() => check('Automatische Minutenprüfung').catch(() => {}), 60000);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(checkInterval);
      adapter.log.info(`[UPDATE ${CURRENT}] unabhängige 0.5.5-Runtime aktiv`);
    } catch (error) {
      const message = error.message || String(error);
      if (adapter.log && typeof adapter.log.warn === 'function') {
        adapter.log.warn(`[UPDATE ${CURRENT}] Runtime-Start Versuch ${bootAttempts} fehlgeschlagen: ${message}`);
      }
      if (!booted && !adapter.isShuttingDown && bootAttempts < 30) {
        setTimeout(() => bootstrap('Retry').catch(() => {}), 3000);
      }
    }
  }

  // Nicht vom ready-Event abhängig: eigener Startversuch plus ready als zusätzliche Absicherung.
  setTimeout(() => bootstrap('Timer').catch(() => {}), 1200);
  adapter.on('ready', () => bootstrap('ready').catch(() => {}));

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

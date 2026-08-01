'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const createBase = require('./main-ipadmini-final-5063.js');

let CURRENT = '0.5.7';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}

const REPO = 'radebold/iobroker.poolsteuerung#main';
const ATOM_URL = 'https://github.com/radebold/iobroker.poolsteuerung/commits/main.atom';
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

function requestText(url, redirects = 0, accept = '*/*') {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': `ioBroker.poolsteuerung/${CURRENT}`,
        Accept: accept,
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache'
      }
    }, res => {
      const status = Number(res.statusCode) || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('Zu viele Weiterleitungen'));
        return requestText(new URL(res.headers.location, url).toString(), redirects + 1, accept).then(resolve, reject);
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (text.length > 524288) req.destroy(new Error('Antwort zu groß'));
      });
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
  });
}

async function readMainSha() {
  const xml = await requestText(`${ATOM_URL}?t=${Date.now()}`, 0, 'application/atom+xml,application/xml,text/xml,*/*');
  const match = xml.match(/\/commit\/([0-9a-f]{40})/i) || xml.match(/Commit\/([0-9a-f]{40})/i);
  if (!match) throw new Error('main-Commit konnte aus Atom-Feed nicht ermittelt werden');
  return match[1].toLowerCase();
}

async function readManifestAtSha(sha) {
  const urls = [
    ['jsdelivr-commit', `https://cdn.jsdelivr.net/gh/radebold/iobroker.poolsteuerung@${sha}/releases/latest.json`],
    ['github-raw-commit', `https://raw.githubusercontent.com/radebold/iobroker.poolsteuerung/${sha}/releases/latest.json`]
  ];
  const errors = [];
  for (const [source, url] of urls) {
    try {
      const text = await requestText(`${url}?t=${Date.now()}`, 0, 'application/json,text/plain,*/*');
      const manifest = JSON.parse(text);
      const version = cleanVersion(manifest && manifest.version);
      if (!parseVersion(version)) throw new Error(`Ungültige Version: ${version || 'leer'}`);
      return {
        version,
        source: `${source}:${sha.slice(0, 8)}`,
        notes: String((manifest && manifest.notes) || ''),
        manifest
      };
    } catch (error) {
      errors.push(`${source}: ${error.message || error}`);
    }
  }
  throw new Error(errors.join(' | ') || 'Manifest am main-Commit konnte nicht gelesen werden');
}

async function readFreshRelease() {
  const sha = await readMainSha();
  const release = await readManifestAtSha(sha);
  return { ...release, sha };
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
  if (!adapter || adapter.__freshCommitUpdater507Installed) return adapter;
  adapter.__freshCommitUpdater507Installed = true;

  let checking = false;
  let lastCheckTrigger = null;
  let lastInstallTrigger = null;
  let currentRelease = null;

  async function ensureStates() {
    try { await adapter.ensureState(IDS.headCommit, 'string', 'text', '', false); } catch {}
  }

  async function writeRelease(release, error = '') {
    const available = !!release && compareVersions(release.version, CURRENT) > 0;
    const pairs = [
      [IDS.installed, CURRENT],
      [IDS.runtimeVersion, CURRENT],
      [IDS.availableVersion, release ? release.version : ''],
      [IDS.remoteSeen, release ? release.version : ''],
      [IDS.available, available],
      [IDS.source, release ? release.source : 'error'],
      [IDS.releaseNotes, release ? release.notes : ''],
      [IDS.lastError, error || ''],
      [IDS.status, error ? 'Update-Prüfung fehlgeschlagen' : (available ? `Update verfügbar: ${CURRENT} → ${release.version}` : `Version ${CURRENT} ist aktuell`)],
      [IDS.headCommit, release && release.sha ? release.sha : '']
    ];
    for (const [id, value] of pairs) await adapter.setStateAsync(id, value, true);
    await adapter.setStateAsync(IDS.lastCheck, Date.now(), true);
    try {
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
    } catch {}
  }

  async function check(reason) {
    if (checking || adapter.isShuttingDown) return currentRelease;
    checking = true;
    try {
      const release = await readFreshRelease();
      currentRelease = release;
      await writeRelease(release, '');
      adapter.log.info(`[UPDATE ${CURRENT}] ${reason}: ${release.version} via ${release.source}`);
      return release;
    } catch (error) {
      const message = error.message || String(error);
      await writeRelease(null, message);
      adapter.log.warn(`[UPDATE ${CURRENT}] Fresh-Commit-Prüfung fehlgeschlagen: ${message}`);
      return null;
    } finally {
      checking = false;
    }
  }

  async function startUpdate() {
    const release = await check('Prüfung vor Installation');
    if (!release || compareVersions(release.version, CURRENT) <= 0) return;
    const cli = cliInfo();
    if (!cli) {
      await adapter.setStateAsync(IDS.lastError, 'ioBroker-CLI iobroker.js wurde nicht gefunden', true);
      await adapter.setStateAsync(IDS.status, 'Update fehlgeschlagen', true);
      return;
    }
    const helperPath = path.join(os.tmpdir(), `iobroker-poolsteuerung-update-${Date.now()}.js`);
    const resultPath = resultFile(adapter.namespace);
    try {
      fs.writeFileSync(helperPath, helperCode(), { encoding: 'utf8', mode: 0o700 });
      try { fs.unlinkSync(resultPath); } catch {}
      await adapter.setStateAsync(IDS.startedAt, Date.now(), true);
      await adapter.setStateAsync(IDS.running, true, true);
      await adapter.setStateAsync(IDS.targetVersion, release.version, true);
      await adapter.setStateAsync(IDS.status, `Update auf ${release.version} wird installiert …`, true);
      await adapter.setStateAsync(IDS.lastError, '', true);
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
          POOL_TARGET: release.version,
          POOL_INSTANCE: adapter.namespace
        }
      });
      child.unref();
      adapter.log.warn(`[UPDATE ${CURRENT}] Installation ${CURRENT} → ${release.version} gestartet.`);
    } catch (error) {
      try { fs.unlinkSync(helperPath); } catch {}
      await adapter.setStateAsync(IDS.running, false, true);
      await adapter.setStateAsync(IDS.startedAt, 0, true);
      await adapter.setStateAsync(IDS.status, 'Update konnte nicht gestartet werden', true);
      await adapter.setStateAsync(IDS.lastError, error.message || String(error), true);
    }
  }

  async function poll() {
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
        // Etwas später als der geerbte 5063-Prüfer schreiben, damit immer die frische SHA-Prüfung gewinnt.
        await new Promise(resolve => setTimeout(resolve, 700));
        await check('VIS-Prüfung');
      }
    } catch {}
  }

  async function boot() {
    if (adapter.isShuttingDown) return;
    try {
      await ensureStates();
      await adapter.setStateAsync(IDS.runtimeVersion, CURRENT, true);
      await adapter.setStateAsync(IDS.runtimeStartedAt, Date.now(), true);
      const [checkState, installState] = await Promise.all([
        adapter.getStateAsync(IDS.checkTrigger),
        adapter.getStateAsync(IDS.installTrigger)
      ]);
      lastCheckTrigger = Number(checkState && checkState.val) || 0;
      lastInstallTrigger = Number(installState && installState.val) || 0;
      await check('Adapterstart');
      const interval = setInterval(() => poll().catch(() => {}), 500);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(interval);
      adapter.log.info(`[UPDATE ${CURRENT}] Fresh-Commit-Updater aktiv: GitHub Atom → jsDelivr@SHA.`);
    } catch (error) {
      const timer = setTimeout(() => boot().catch(() => {}), 1500);
      if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
    }
  }

  const timer = setTimeout(() => boot().catch(() => {}), 2600);
  if (typeof adapter.trackTimeout === 'function') adapter.trackTimeout(timer);
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

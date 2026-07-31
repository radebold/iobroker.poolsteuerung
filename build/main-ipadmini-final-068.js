'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const createBase = require('./main-ipadmini-final-067.js');

let CURRENT = '0.4.68';
try { CURRENT = String(require('../package.json').version || CURRENT).replace(/^v/i, ''); } catch {}
const VERSION = `v${CURRENT}`;
const REPO = 'radebold/iobroker.poolsteuerung#main';
const REMOTE = 'https://raw.githubusercontent.com/radebold/iobroker.poolsteuerung/main/package.json';
const TABLET = ['vis.htmlTablet', 'vis.widgetTablet'];
const VIS = [...TABLET, 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];
const ID = {
  installed: 'update.installedVersion', availableVersion: 'update.availableVersion', available: 'update.available',
  check: 'update.checkTrigger', install: 'update.installTrigger', running: 'update.running', status: 'update.status',
  lastCheck: 'update.lastCheck', error: 'update.lastError', started: 'update.startedAt', target: 'update.targetVersion'
};

const clean = value => String(value || '').trim().replace(/^v/i, '');
function parsed(value) {
  const m = clean(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]([\w.-]+))?$/);
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], s: m[4] || '' } : null;
}
function compare(a, b) {
  a = parsed(a); b = parsed(b); if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] > b.n[i] ? 1 : -1;
  if (a.s === b.s) return 0; if (!a.s) return 1; if (!b.s) return -1;
  return a.s.localeCompare(b.s, undefined, { numeric: true, sensitivity: 'base' });
}
const patchVersion = value => String(value || '').replace(/v0\.4\.\d+(?:[-+][\w.-]+)?/g, VERSION);
const html = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const attr = value => html(value).replace(/\r?\n/g, ' ');

function getText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': `ioBroker.poolsteuerung/${CURRENT}`, Accept: 'application/json', 'Cache-Control': 'no-cache' } }, res => {
      const code = Number(res.statusCode) || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 4) return reject(new Error('Zu viele GitHub-Weiterleitungen'));
        return getText(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (code !== 200) { res.resume(); return reject(new Error(`GitHub HTTP ${code}`)); }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; if (text.length > 131072) req.destroy(new Error('GitHub-Antwort zu groß')); });
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    req.setTimeout(12000, () => req.destroy(new Error('GitHub-Zeitüberschreitung')));
    req.on('error', reject);
  });
}
async function remoteVersion() {
  let data;
  try { data = JSON.parse(await getText(`${REMOTE}?ts=${Date.now()}`)); } catch (e) { throw new Error(e.message || String(e)); }
  const version = clean(data && data.version);
  if (!parsed(version)) throw new Error(`Ungültige GitHub-Version: ${version || 'leer'}`);
  return version;
}
function cliInfo() {
  for (const p of [path.resolve(__dirname, '../../../iobroker.js'), path.resolve(process.cwd(), 'iobroker.js'), '/opt/iobroker/iobroker.js']) {
    try { if (fs.statSync(p).isFile()) return { cli: p, cwd: path.dirname(p) }; } catch {}
  }
  return null;
}
const resultFile = ns => path.join(os.tmpdir(), `${String(ns).replace(/[^\w.-]/g, '_')}-github-update-result.json`);
function helperCode() {
  return `'use strict';\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');\n` +
    `const e=process.env,n=e.POOL_NODE,c=e.POOL_CLI,r=e.POOL_ROOT,f=e.POOL_RESULT,h=e.POOL_HELPER,t=e.POOL_TARGET||'',i=e.POOL_INSTANCE||'poolsteuerung.0';\n` +
    `const tail=v=>{v=String(v||'');return v.length>12000?v.slice(-12000):v};\n` +
    `const run=(a,m)=>spawnSync(n,[c].concat(a),{cwd:r,encoding:'utf8',timeout:m,maxBuffer:8*1024*1024,env:e});\n` +
    `setTimeout(()=>{let x;try{x=run(['url','${REPO}','poolsteuerung'],900000)}catch(q){x={status:-1,error:q}}const ok=!!x&&!x.error&&x.status===0;` +
    `try{fs.writeFileSync(f,JSON.stringify({ts:Date.now(),success:ok,targetVersion:t,code:x&&x.status,stdout:tail(x&&x.stdout),stderr:tail((x&&x.stderr)||(x&&x.error&&x.error.message))},null,2))}catch(q){}` +
    `try{run(['restart',i],120000)}catch(q){}try{fs.unlinkSync(h)}catch(q){}process.exit(ok?0:1)},900);\n`;
}
function handler(namespace, target) {
  const install = `${namespace}.${ID.install}`.replace(/'/g, "\\'");
  const check = `${namespace}.${ID.check}`.replace(/'/g, "\\'");
  target = String(target || '').replace(/'/g, "\\'");
  return attr(`event.preventDefault();event.stopPropagation();var b=this;if(b.dataset.running==='1')return false;var u=b.dataset.available==='1';if(u&&!confirm('Poolsteuerung auf Version ${target} aktualisieren?'))return false;var id=u?'${install}':'${check}',v=null;try{v=window.vis}catch(e){}try{if(!v&&window.parent)v=window.parent.vis}catch(e){}try{if(!v&&window.top)v=window.top.vis}catch(e){}if(!v){alert('VIS-Verbindung nicht verfügbar');return false}b.disabled=true;var old=b.textContent;b.textContent=u?'START …':'PRÜFE …';function d(){setTimeout(function(){b.disabled=false;b.textContent=old},1800)}try{var r=typeof v.setValue==='function'?v.setValue(id,Date.now()):(v.conn&&typeof v.conn.setState==='function'?v.conn.setState(id,Date.now()):null);r&&typeof r.then==='function'?r.then(d,function(e){d();alert('Auftrag fehlgeschlagen: '+e)}):d()}catch(e){d();alert('Auftrag fehlgeschlagen: '+e.message)}return false;`);
}
const STYLE = `<style data-pool-update-068="1">.pool-update-btn{appearance:none;height:25px;margin-left:8px;padding:0 9px;border:1px solid rgba(255,255,255,.15);border-radius:999px;background:rgba(255,255,255,.07);color:#c5d5e8;font:900 8px/1 Arial;white-space:nowrap;vertical-align:middle;cursor:pointer}.pool-update-btn.available{background:linear-gradient(135deg,#f59e0b,#e87918);border-color:rgba(255,214,117,.55);color:#fff}.pool-update-btn.running{background:linear-gradient(135deg,#278bd4,#25bfb5);color:#fff;cursor:wait}.pool-update-btn.error{background:rgba(255,107,87,.15);border-color:rgba(255,107,87,.35);color:#ffc0b7}.pool-update-btn:disabled{opacity:.7}.ps-title .pool-update-btn{height:24px;margin-left:7px;padding:0 8px}</style>`;
function patchTablet(value, namespace, info) {
  let out = patchVersion(value);
  if (!out) return out;
  out = out.replace(/<style data-pool-update-068="1">[\s\S]*?<\/style>/g, '').replace(/<button\b[^>]*data-pool-update-068="1"[^>]*>[\s\S]*?<\/button>/g, '');
  const running = !!info.running;
  const available = !!info.available && compare(info.availableVersion, CURRENT) > 0;
  const error = !!info.error && !running;
  const text = running ? 'UPDATE LÄUFT' : available ? `UPDATE ${info.availableVersion}` : error ? 'PRÜFEN' : 'AKTUELL';
  const cls = running ? 'running' : available ? 'available' : error ? 'error' : 'current';
  const button = `<button type="button" class="pool-update-btn ${cls}" data-pool-update-068="1" data-available="${available ? 1 : 0}" data-running="${running ? 1 : 0}" title="${attr(info.status || `Installiert: ${CURRENT}`)}" onclick="${handler(namespace, info.availableVersion)}"${running ? ' disabled' : ''}>${html(text)}</button>`;
  const normal = /(<span class="ver">[^<]*<\/span>)/, widget = /(<span class="ps-ver">[^<]*<\/span>)/;
  if (normal.test(out)) out = out.replace(normal, `$1${button}`); else if (widget.test(out)) out = out.replace(widget, `$1${button}`); else return out;
  return out.includes('</head>') ? out.replace('</head>', `${STYLE}</head>`) : out + STYLE;
}

function install(adapter) {
  if (!adapter || adapter.__githubUpdate068Installed) return adapter;
  adapter.__githubUpdate068Installed = true;
  adapter.__githubUpdate068Info = { installedVersion: CURRENT, availableVersion: '', available: false, running: false, status: `Installiert: ${CURRENT}`, error: '', target: '' };
  adapter.__githubUpdate068Busy = false;
  adapter.__githubUpdate068Check = null;
  adapter.__githubUpdate068Install = null;
  adapter.__githubUpdate068Render = null;

  async function ensureValue(id, type, role, def, write) {
    await adapter.ensureState(id, type, role, def, write);
    const s = await adapter.getStateAsync(id);
    if (!s || s.val === null || s.val === undefined || s.val === '') await adapter.setStateAsync(id, def, true);
  }
  async function ensureStates() {
    try { await adapter.setObjectNotExistsAsync('update', { type: 'channel', common: { name: 'GitHub-Update' }, native: {} }); } catch {}
    await ensureValue(ID.installed, 'string', 'info.version', CURRENT, false);
    await ensureValue(ID.availableVersion, 'string', 'info.version', '', false);
    await ensureValue(ID.available, 'boolean', 'indicator', false, false);
    await ensureValue(ID.check, 'number', 'button', 0, true);
    await ensureValue(ID.install, 'number', 'button', 0, true);
    await ensureValue(ID.running, 'boolean', 'indicator.working', false, false);
    await ensureValue(ID.status, 'string', 'text', `Installiert: ${CURRENT}`, false);
    await ensureValue(ID.lastCheck, 'number', 'value.time', 0, false);
    await ensureValue(ID.error, 'string', 'text', '', false);
    await ensureValue(ID.started, 'number', 'value.time', 0, false);
    await ensureValue(ID.target, 'string', 'info.version', '', false);
    await adapter.setStateIfChanged(ID.installed, CURRENT, true);
  }
  async function loadInfo() {
    const s = await Promise.all([ID.availableVersion, ID.available, ID.running, ID.status, ID.error, ID.target].map(id => adapter.getStateAsync(id)));
    Object.assign(adapter.__githubUpdate068Info, { availableVersion: clean(s[0] && s[0].val), available: !!(s[1] && s[1].val), running: !!(s[2] && s[2].val), status: String((s[3] && s[3].val) || ''), error: String((s[4] && s[4].val) || ''), target: clean(s[5] && s[5].val) });
  }
  function render() {
    if (adapter.__githubUpdate068Render || adapter.isShuttingDown) return;
    const h = adapter.trackTimeout(setTimeout(async () => { adapter.pendingTimeouts.delete(h); adapter.__githubUpdate068Render = null; adapter.lastRenderSignature = ''; adapter.lastRenderAt = 0; try { await adapter.forceImmediateRender(); } catch { try { await patchStates(); } catch {} } }, 150));
    adapter.__githubUpdate068Render = h;
  }
  async function write(changes) {
    Object.assign(adapter.__githubUpdate068Info, changes);
    const i = adapter.__githubUpdate068Info;
    const map = [[ID.installed, CURRENT], [ID.availableVersion, i.availableVersion], [ID.available, !!i.available], [ID.running, !!i.running], [ID.status, i.status], [ID.error, i.error], [ID.target, i.target]];
    for (const [id, value] of map) await adapter.setStateIfChanged(id, value === undefined ? '' : value, true);
    if (Object.prototype.hasOwnProperty.call(changes, 'lastCheck')) await adapter.setStateIfChanged(ID.lastCheck, Number(changes.lastCheck) || 0, true);
    render();
  }
  async function patchStates() {
    for (const id of VIS) try {
      const s = await adapter.getStateAsync(id), cur = String((s && s.val) || '');
      const next = TABLET.includes(id) ? patchTablet(cur, adapter.namespace, adapter.__githubUpdate068Info) : patchVersion(cur);
      if (next && next !== cur) await adapter.setStateIfChanged(id, next, true);
    } catch (e) { if (!adapter.isDbClosedError(e) && adapter.config.debugMode) adapter.log.debug(`[UPDATE] VIS-Patch ${id}: ${e.message || e}`); }
  }
  async function helperResult() {
    const file = resultFile(adapter.namespace);
    if (!fs.existsSync(file)) {
      const [r, st] = await Promise.all([adapter.getStateAsync(ID.running), adapter.getStateAsync(ID.started)]);
      if (r && r.val && Number(st && st.val) && Date.now() - Number(st.val) > 86400000) await write({ running: false, status: 'Update wurde unterbrochen', error: 'Kein Update-Ergebnis innerhalb von 24 Stunden' });
      return;
    }
    let x; try { x = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { x = { success: false, stderr: e.message }; }
    try { fs.unlinkSync(file); } catch {}
    const target = clean(x && x.targetVersion), reached = !target || compare(CURRENT, target) >= 0;
    if (x && x.success && reached) await write({ running: false, status: `Update erfolgreich · Version ${CURRENT}`, error: '', target: '', available: false, availableVersion: CURRENT });
    else await write({ running: false, status: 'Update fehlgeschlagen', error: x && x.success ? `Ziel ${target} nicht erreicht; installiert ${CURRENT}` : String((x && (x.stderr || x.stdout)) || 'Unbekannter Installationsfehler').trim(), target: '' });
    await adapter.setStateIfChanged(ID.started, 0, true);
  }
  async function check(reason) {
    if (adapter.__githubUpdate068Busy || adapter.isShuttingDown) return null;
    adapter.__githubUpdate068Busy = true;
    try {
      await write({ status: 'Prüfe GitHub auf neue Version …', error: '' });
      const remote = await remoteVersion(), available = compare(remote, CURRENT) > 0;
      await write({ availableVersion: remote, available, lastCheck: Date.now(), status: available ? `Update verfügbar: ${CURRENT} → ${remote}` : `Version ${CURRENT} ist aktuell`, error: '' });
      adapter.log.info(`[UPDATE] ${reason}: installiert ${CURRENT}, GitHub ${remote}${available ? ' – Update verfügbar' : ''}`);
      return { remote, available };
    } catch (e) {
      const text = e.message || String(e); await write({ status: 'Update-Prüfung fehlgeschlagen', error: text, lastCheck: Date.now() }); adapter.log.warn('[UPDATE] ' + text); return null;
    } finally { adapter.__githubUpdate068Busy = false; }
  }
  async function start() {
    if (adapter.__githubUpdate068Info.running) return;
    const c = await check('Prüfung vor Installation');
    if (!c || !c.available) return;
    const cli = cliInfo();
    if (!cli) return write({ status: 'Update fehlgeschlagen', error: 'ioBroker-CLI iobroker.js wurde nicht gefunden' });
    const result = resultFile(adapter.namespace), helper = path.join(os.tmpdir(), `iobroker-poolsteuerung-update-${Date.now()}.js`);
    try {
      fs.writeFileSync(helper, helperCode(), { encoding: 'utf8', mode: 0o700 }); try { fs.unlinkSync(result); } catch {}
      await adapter.setStateIfChanged(ID.started, Date.now(), true); await write({ running: true, target: c.remote, status: `Update auf ${c.remote} wird installiert …`, error: '' });
      const child = spawn(process.execPath, [helper], { cwd: cli.cwd, detached: true, stdio: 'ignore', env: { ...process.env, POOL_NODE: process.execPath, POOL_CLI: cli.cli, POOL_ROOT: cli.cwd, POOL_RESULT: result, POOL_HELPER: helper, POOL_TARGET: c.remote, POOL_INSTANCE: adapter.namespace } });
      child.once('error', async e => { try { fs.unlinkSync(helper); } catch {} await write({ running: false, target: '', status: 'Update konnte nicht gestartet werden', error: e.message || String(e) }); await adapter.setStateIfChanged(ID.started, 0, true); });
      child.unref(); adapter.log.warn(`[UPDATE] Update auf ${c.remote} gestartet; Adapter wird neu gestartet.`);
    } catch (e) { try { fs.unlinkSync(helper); } catch {} await write({ running: false, target: '', status: 'Update konnte nicht vorbereitet werden', error: e.message || String(e) }); }
  }
  async function poll() {
    try {
      const [a, b] = await Promise.all([adapter.getStateAsync(ID.check), adapter.getStateAsync(ID.install)]), cv = Number(a && a.val) || 0, iv = Number(b && b.val) || 0;
      if (iv && iv !== adapter.__githubUpdate068Install) { adapter.__githubUpdate068Install = iv; await start(); }
      else if (cv && cv !== adapter.__githubUpdate068Check) { adapter.__githubUpdate068Check = cv; await check('Manuelle Tablet-Prüfung'); }
    } catch {}
  }
  function pollLater() { if (adapter.isShuttingDown) return; const h = adapter.trackTimeout(setTimeout(async () => { adapter.pendingTimeouts.delete(h); await poll(); pollLater(); }, 1000)); }

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) if (typeof adapter[name] === 'function') { const base = adapter[name].bind(adapter); adapter[name] = data => patchTablet(base({ ...(data || {}), adapterVersion: VERSION }), adapter.namespace, adapter.__githubUpdate068Info); }
  for (const name of ['buildPhoneHtml', 'buildPhoneWidget']) if (typeof adapter[name] === 'function') { const base = adapter[name].bind(adapter); adapter[name] = data => patchVersion(base({ ...(data || {}), adapterVersion: VERSION })); }
  if (typeof adapter.renderVisFull === 'function') { const base = adapter.renderVisFull.bind(adapter); adapter.renderVisFull = async (...args) => { const result = await base(...args); await patchStates(); return result; }; }
  adapter.on('ready', () => { const h = adapter.trackTimeout(setTimeout(async () => { adapter.pendingTimeouts.delete(h); if (adapter.isShuttingDown) return; try { await ensureStates(); await loadInfo(); await helperResult(); const [a, b] = await Promise.all([adapter.getStateAsync(ID.check), adapter.getStateAsync(ID.install)]); adapter.__githubUpdate068Check = Number(a && a.val) || 0; adapter.__githubUpdate068Install = Number(b && b.val) || 0; pollLater(); await patchStates(); await check('Adapterstart'); const timer = setInterval(() => check('6-Stunden-Prüfung').catch(() => {}), 21600000); if (typeof adapter.trackInterval === 'function') adapter.trackInterval(timer); adapter.log.info(`[UPDATE] ${VERSION}: Tablet-Updatebutton aktiv`); } catch (e) { if (!adapter.isDbClosedError(e)) adapter.log.error('[UPDATE] Initialisierung: ' + (e.message || e)); } }, 2400)); });
  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter; else createAdapter();

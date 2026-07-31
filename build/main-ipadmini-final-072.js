'use strict';

const createBase = require('./main-ipadmini-final-071.js');

const VERSION = 'v0.4.72';
const CURRENT = '0.4.72';
const REMOTE_PACKAGE = 'https://raw.githubusercontent.com/radebold/iobroker.poolsteuerung/main/package.json';
const TABLET_STATES = ['vis.htmlTablet', 'vis.widgetTablet'];
const ALL_VIS_STATES = [...TABLET_STATES, 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function runtimeScript(namespace) {
  return `<script data-pool-update-runtime-072="1">
(function(){
  const NS=${JSON.stringify(namespace)};
  const CURRENT=${JSON.stringify(CURRENT)};
  const REMOTE=${JSON.stringify(REMOTE_PACKAGE)};
  let bound=false;

  function parseVersion(value){
    const m=String(value||'').trim().replace(/^v/i,'').match(/^(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+]([\\w.-]+))?$/);
    return m?{n:[Number(m[1]),Number(m[2]),Number(m[3])],s:m[4]||''}:null;
  }
  function compareVersions(a,b){
    a=parseVersion(a); b=parseVersion(b); if(!a||!b)return 0;
    for(let i=0;i<3;i++){ if(a.n[i]!==b.n[i]) return a.n[i]>b.n[i]?1:-1; }
    if(a.s===b.s)return 0; if(!a.s)return 1; if(!b.s)return -1;
    return a.s.localeCompare(b.s,undefined,{numeric:true,sensitivity:'base'});
  }
  function candidates(){
    const out=[];
    try{ if(window.vis)out.push(window.vis); }catch(e){}
    try{ if(window.parent&&window.parent!==window&&window.parent.vis&&!out.includes(window.parent.vis))out.push(window.parent.vis); }catch(e){}
    try{ if(window.top&&window.top!==window&&window.top.vis&&!out.includes(window.top.vis))out.push(window.top.vis); }catch(e){}
    return out;
  }
  async function setStateReliable(id,value){
    try{
      if(typeof window.poolSetState==='function'){
        const result=await Promise.resolve(window.poolSetState(id,value));
        if(result!==false)return true;
      }
    }catch(e){}
    for(const vis of candidates()){
      try{
        if(vis&&vis.conn&&typeof vis.conn.setState==='function'){
          const result=vis.conn.setState(id,value);
          if(result&&typeof result.then==='function')await result;
          return true;
        }
      }catch(e){}
    }
    for(const vis of candidates()){
      try{
        if(vis&&typeof vis.setValue==='function'){
          const result=vis.setValue(id,value);
          if(result&&typeof result.then==='function')await result;
          return true;
        }
      }catch(e){}
    }
    return false;
  }
  function cachedState(relative){
    const id=NS+'.'+relative;
    for(const vis of candidates()){
      try{
        const states=vis&&vis.states;
        if(!states)continue;
        const keys=[id+'.val',id];
        for(const key of keys){
          if(Object.prototype.hasOwnProperty.call(states,key)){
            const value=states[key];
            if(value&&typeof value==='object'&&Object.prototype.hasOwnProperty.call(value,'val'))return value.val;
            return value;
          }
        }
      }catch(e){}
    }
    return undefined;
  }
  function button(){ return document.querySelector('button[data-pool-update-068="1"]'); }
  function show(btn,text,kind,title){
    if(!btn)return;
    btn.textContent=text;
    btn.classList.remove('available','running','error','current');
    if(kind)btn.classList.add(kind);
    if(title)btn.title=title;
  }
  function applyKnownStates(btn){
    const running=cachedState('update.running');
    const status=cachedState('update.status');
    const remote=String(cachedState('update.availableVersion')||'').replace(/^v/i,'');
    const available=cachedState('update.available')===true||cachedState('update.available')==='true'||compareVersions(remote,CURRENT)>0;
    if(running===true||running==='true'){
      btn.dataset.running='1';
      show(btn,'UPDATE LÄUFT','running',String(status||'Update läuft'));
      return true;
    }
    btn.dataset.running='0';
    if(available&&parseVersion(remote)){
      btn.dataset.available='1';
      btn.dataset.target=remote;
      show(btn,'UPDATE '+remote,'available',String(status||('Update '+CURRENT+' → '+remote)));
      return true;
    }
    if(status)btn.title=String(status);
    return false;
  }
  async function checkRemote(btn,manual){
    if(!btn||btn.dataset.checking==='1'||btn.dataset.running==='1')return;
    btn.dataset.checking='1';
    show(btn,'PRÜFE …','running','GitHub-Version wird geprüft');
    const stateWrite=setStateReliable(NS+'.update.checkTrigger',Date.now()).catch(function(){return false;});
    try{
      const response=await fetch(REMOTE+'?ts='+Date.now(),{cache:'no-store',headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error('GitHub HTTP '+response.status);
      const data=await response.json();
      const remote=String(data&&data.version||'').trim().replace(/^v/i,'');
      if(!parseVersion(remote))throw new Error('Ungültige GitHub-Version');
      const available=compareVersions(remote,CURRENT)>0;
      btn.dataset.target=remote;
      btn.dataset.available=available?'1':'0';
      btn.dataset.running='0';
      show(btn,available?('UPDATE '+remote):'AKTUELL',available?'available':'current',available?('Installiert '+CURRENT+' · verfügbar '+remote):('Version '+CURRENT+' ist aktuell'));
      await stateWrite;
    }catch(error){
      await stateWrite;
      btn.dataset.running='0';
      if(!applyKnownStates(btn)){
        btn.dataset.available='0';
        show(btn,'PRÜFEN','error','Update-Prüfung fehlgeschlagen: '+(error&&error.message?error.message:error));
        if(manual)alert('Update-Prüfung fehlgeschlagen: '+(error&&error.message?error.message:error));
      }
    }finally{
      btn.dataset.checking='0';
    }
  }
  async function onClick(event){
    try{event.preventDefault();event.stopPropagation();}catch(e){}
    const btn=button(); if(!btn||btn.dataset.running==='1'||btn.dataset.checking==='1')return false;
    let target=String(btn.dataset.target||cachedState('update.availableVersion')||'').replace(/^v/i,'');
    let available=btn.dataset.available==='1'||compareVersions(target,CURRENT)>0;
    if(!available){
      await checkRemote(btn,true);
      target=String(btn.dataset.target||'').replace(/^v/i,'');
      available=btn.dataset.available==='1'&&compareVersions(target,CURRENT)>0;
      if(!available)return false;
    }
    if(!confirm('Poolsteuerung von '+CURRENT+' auf '+target+' aktualisieren?'))return false;
    show(btn,'UPDATE STARTET','running','Updateauftrag wird an ioBroker übertragen');
    btn.dataset.running='1';
    const ok=await setStateReliable(NS+'.update.installTrigger',Date.now());
    if(!ok){
      btn.dataset.running='0';
      show(btn,'UPDATE '+target,'error','Updateauftrag konnte nicht geschrieben werden');
      alert('Updateauftrag konnte nicht an ioBroker geschrieben werden.');
      return false;
    }
    setTimeout(function(){ applyKnownStates(btn); },1500);
    return false;
  }
  function init(){
    const btn=button(); if(!btn)return;
    btn.removeAttribute('onclick');
    if(!bound){
      bound=true;
      btn.addEventListener('click',onClick,false);
    }
    applyKnownStates(btn);
    setTimeout(function(){checkRemote(btn,false);},350);
    setInterval(function(){ const current=button(); if(current)applyKnownStates(current); },1000);
    setInterval(function(){ const current=button(); if(current)checkRemote(current,false); },300000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
</script>`;
}

function patchTablet(value, namespace) {
  let html = patchVersion(value);
  if (!html) return html;
  html = html.replace(/<script data-pool-update-runtime-072="1">[\s\S]*?<\/script>/g, '');
  html = html.replace(/<button\b(?=[^>]*data-pool-update-068="1")[^>]*>/gi, tag => {
    let next = tag.replace(/\s+onclick="[^"]*"/i, '');
    if (!/data-pool-update-runtime-072=/i.test(next)) {
      next = next.replace(/>$/, ' data-pool-update-runtime-072="1">');
    }
    return next;
  });
  const script = runtimeScript(namespace);
  if (html.includes('</body>')) return html.replace('</body>', `${script}</body>`);
  return `${html}${script}`;
}

async function patchExistingStates(adapter) {
  for (const id of ALL_VIS_STATES) {
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = TABLET_STATES.includes(id) ? patchTablet(current, adapter.namespace) : patchVersion(current);
      if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
    } catch (error) {
      if (!adapter.isDbClosedError(error) && adapter.config.debugMode) {
        adapter.log.debug(`[UPDATE] Runtime-Patch für ${id} fehlgeschlagen: ${error.message || error}`);
      }
    }
  }
}

function install(adapter) {
  if (!adapter || adapter.__updateRuntime072Installed) return adapter;
  adapter.__updateRuntime072Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchTablet(original({ ...(data || {}), adapterVersion: VERSION }), adapter.namespace);
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
      await patchExistingStates(adapter);
      return result;
    };
  }
  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      adapter.lastRenderSignature = '';
      adapter.lastRenderAt = 0;
      try { await adapter.forceImmediateRender(); } catch {}
      try { await patchExistingStates(adapter); } catch {}
      try { await adapter.setStateAsync('update.checkTrigger', Date.now(), true); } catch {}
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info(`[UPDATE] ${VERSION}: Tablet-Button prüft GitHub direkt und schreibt über vis.conn.setState`);
      }
    }, 2200));
  });
  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

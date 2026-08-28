'use strict';

// 0.5.74: EIN zentraler Versionsbesitzer fuer alle VIS-States.
// Historische Wrapper (u.a. 0.5.41 / 0.5.51 / 0.5.63) duerfen intern weiterhin
// ihre Texte patchen. Am letzten Schreibpunkt setStateAsync wird die sichtbare
// Version jedoch zwingend auf 0.5.74 normalisiert. Damit kann kein alter,
// zwischengespeicherter Writer die VIS-Version mehr zuruecksetzen.
const createBase = require('./main-ipadmini-final-573.js');

const VERSION = 'v0.5.74';
const VIS_IDS = new Set([
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
]);

function localId(adapter, id) {
  const s = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function normalizeVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function detectVersions(value) {
  const found = String(value || '').match(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g) || [];
  return [...new Set(found)];
}

function install(adapter) {
  if (!adapter || adapter.__visVersionOwner574Installed) return adapter;
  adapter.__visVersionOwner574Installed = true;

  const rawSetStateAsync = adapter.setStateAsync.bind(adapter);
  let lastLegacy = '';
  let rewriteCount = 0;

  // FINALER Schreibschutz: jeder lokale VIS-Write laeuft hier durch,
  // auch wenn ein alter Wrapper einen zuvor gecachten Writer verwendet.
  adapter.setStateAsync = async function setStateAsync574(id, value, ack, ...rest) {
    const local = localId(adapter, id);
    if (VIS_IDS.has(local) && typeof value === 'string') {
      const before = String(value);
      const versions = detectVersions(before).filter(v => v !== VERSION);
      const after = normalizeVersion(before);
      if (versions.length) {
        lastLegacy = versions.join(', ');
        rewriteCount++;
      }
      return rawSetStateAsync(id, after, ack, ...rest);
    }
    return rawSetStateAsync(id, value, ack, ...rest);
  };

  async function ensureDiagnostics() {
    await adapter.setObjectNotExistsAsync('status.debug.visVersionOwner', {
      type:'state', common:{name:'VIS Versionsbesitzer',type:'string',role:'text',read:true,write:false,def:''}, native:{}
    });
    await adapter.setObjectNotExistsAsync('status.debug.visVersionLegacyBlocked', {
      type:'state', common:{name:'Zuletzt blockierte alte VIS-Version',type:'string',role:'text',read:true,write:false,def:''}, native:{}
    });
    await adapter.setObjectNotExistsAsync('status.debug.visVersionRewriteCount', {
      type:'state', common:{name:'Anzahl blockierter VIS-Versionswrites',type:'number',role:'value',read:true,write:false,def:0}, native:{}
    });
  }

  async function publishDiagnostics() {
    try {
      await ensureDiagnostics();
      await rawSetStateAsync('status.debug.visVersionOwner', '0.5.74 · finaler setStateAsync-Guard · einzige sichtbare VIS-Version', true);
      await rawSetStateAsync('status.debug.visVersionLegacyBlocked', lastLegacy || 'noch keine Altversion abgefangen', true);
      await rawSetStateAsync('status.debug.visVersionRewriteCount', rewriteCount, true);
    } catch {}
  }

  // Auch Builder-Daten bekommen bereits die korrekte Version; der finale Guard
  // bleibt trotzdem die verbindliche letzte Instanz.
  for (const name of ['buildTabletHtml','buildTabletWidget','buildPhoneHtml','buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => normalizeVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  adapter.on('ready', () => {
    const h = adapter.trackTimeout(setTimeout(async () => {
      try { adapter.pendingTimeouts.delete(h); } catch {}
      if (adapter.isShuttingDown) return;
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.renderVisFull === 'function') await adapter.renderVisFull(true);
      } catch {}
      await publishDiagnostics();
      const timer = setInterval(() => { if (!adapter.isShuttingDown) publishDiagnostics().catch(() => {}); }, 30000);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(timer);
    }, 2200));
  });

  return adapter;
}

function createAdapter(options = {}) { return install(createBase(options)); }
if (require.main !== module) module.exports = createAdapter;
else createAdapter();

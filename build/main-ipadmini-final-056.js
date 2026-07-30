'use strict';

const createBase = require('./main-ipadmini-final-054.js');

const VERSION = 'v0.4.56';
const IPAD_STATE = 'vis.htmlIpadMini';
const EDIT_STATE = 'control.ph.calibration.ipadMiniEditing';
const RAW_PH_STATE = 'ph803w.0.N7EtmEWYCMVBROOHzkV9zT.ph.value';
const IPAD_RENDER_INTERVAL_MS = 20000;
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', IPAD_STATE];

function patchVersion(value) {
  return String(value || '').replace(/v0\.4\.\d+/g, VERSION);
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'on', 'ein', 'ja', 'yes', 'active', 'aktiv'].includes(String(value ?? '').trim().toLowerCase());
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function editingWriteCode(namespace, value) {
  const id = `${String(namespace || 'poolsteuerung.0')}.${EDIT_STATE}`
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
  const literal = value ? 'true' : 'false';
  return [
    "var ev=window.vis||(window.parent&&window.parent.vis)||(window.top&&window.top.vis)",
    `if(ev){if(typeof ev.setValue==='function'){ev.setValue('${id}',${literal})}else if(ev.conn&&typeof ev.conn.setState==='function'){ev.conn.setState('${id}',${literal})}}`
  ].join(';');
}

function patchEditingHandlers(value, namespace) {
  let html = String(value || '');
  if (!html.includes('data-ph-cal-modal="1"')) return html;
  if (html.includes('data-ipad-edit-lock="1"')) return html;

  const openCode = escapeAttribute(editingWriteCode(namespace, true));
  const closeCode = escapeAttribute(editingWriteCode(namespace, false));

  html = html
    .replace("if(m)m.style.display='flex'", `if(m)m.style.display='flex';${openCode}`)
    .replace(/if\(m\)m\.style\.display='none'/g, `if(m)m.style.display='none';${closeCode}`)
    .replace(/document\.getElementById\('pool-ph-cal-modal'\)\.style\.display='none'/g, `document.getElementById('pool-ph-cal-modal').style.display='none';${closeCode}`)
    .replace('data-ph-cal-modal="1"', 'data-ph-cal-modal="1" data-ipad-edit-lock="1"');

  const backdropOld = 'onclick="if(event.target===this)this.style.display=\'none\'"';
  const backdropNew = `onclick="if(event.target===this){this.style.display='none';${closeCode}}"`;
  return html.replace(backdropOld, backdropNew);
}

function patchCanisterSize(value) {
  return String(value || '')
    .replace('.canister{min-width:135px;padding:3px 7px;', '.canister{min-width:182px;padding:5px 10px;')
    .replace('.canister b{font-size:8px}', '.canister b{font-size:12px;line-height:1.15;white-space:nowrap}')
    .replace('.canister small{font-size:7px;color:#9bb0c8}', '.canister small{font-size:10px;line-height:1.15;color:#b7c9dc;margin-top:2px;white-space:nowrap}')
    .replace('.canister{min-width:120px}', '.canister{min-width:164px}');
}

function formatRawPh(value) {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number.toFixed(2).replace('.', ',') : '--';
}

function patchRawPh(value, rawPh) {
  let html = String(value || '');
  if (!html || !html.includes('<span class="metric-label">pH-Wert</span>')) return html;

  const rawText = formatRawPh(rawPh);
  if (!html.includes('data-ph-raw-style="1"')) {
    const style = '<style data-ph-raw-style="1">.ph-raw{font-size:18px;font-weight:650;line-height:1;color:#b9c9da;letter-spacing:0;margin-left:4px;align-self:center;white-space:nowrap;transform:translateY(5px)}@media(max-width:900px){.ph-raw{font-size:16px;margin-left:3px;transform:translateY(4px)}}</style>';
    html = html.replace('<main class="ipad-final">', `${style}<main class="ipad-final">`);
  }

  const existing = /<span class="ph-raw" data-ph-raw="1">\([^<]*\)<\/span>/;
  if (existing.test(html)) {
    return html.replace(existing, `<span class="ph-raw" data-ph-raw="1">(${rawText})</span>`);
  }

  const labelIndex = html.indexOf('<span class="metric-label">pH-Wert</span>');
  const readingIndex = html.indexOf('<div class="metric-reading', labelIndex);
  const sectionEnd = html.indexOf('</section>', readingIndex);
  if (readingIndex < 0 || sectionEnd < 0) return html;

  const before = html.slice(0, readingIndex);
  let section = html.slice(readingIndex, sectionEnd);
  section = section.replace(/(<span class="metric-value">[^<]*<\/span>)/, `$1<span class="ph-raw" data-ph-raw="1">(${rawText})</span>`);
  return before + section + html.slice(sectionEnd);
}

function patchIpad(value, namespace, rawPh) {
  let html = patchVersion(value);
  html = patchCanisterSize(html);
  html = patchEditingHandlers(html, namespace);
  html = patchRawPh(html, rawPh);
  return html;
}

async function getRawPh(adapter) {
  try {
    const state = await adapter.getForeignStateAsync(RAW_PH_STATE);
    return state ? state.val : null;
  } catch {
    return null;
  }
}

async function ensureEditingState(adapter) {
  try {
    await adapter.setObjectNotExistsAsync(EDIT_STATE, {
      type: 'state',
      common: {
        name: 'iPad Mini PoolLab-Eingabe geöffnet',
        type: 'boolean',
        role: 'indicator',
        read: true,
        write: true,
        def: false
      },
      native: {}
    });
    const state = await adapter.getStateAsync(EDIT_STATE);
    if (!state || state.val === null || state.val === undefined) await adapter.setStateAsync(EDIT_STATE, false, true);
  } catch (error) {
    if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
      adapter.log.warn('[IPAD-MINI] Editing-State konnte nicht angelegt werden: ' + (error.message || error));
    }
  }
}

async function isEditing(adapter) {
  try {
    const state = await adapter.getStateAsync(EDIT_STATE);
    return boolValue(state && state.val);
  } catch {
    return false;
  }
}

async function patchOtherVersions(adapter) {
  for (const id of VIS_STATES) {
    if (id === IPAD_STATE) continue;
    try {
      const state = await adapter.getStateAsync(id);
      const current = String((state && state.val) || '');
      const next = patchVersion(current);
      if (next && next !== current) await adapter.__originalSetStateIfChanged056(id, next, true);
    } catch {}
  }
}

function install(adapter) {
  if (!adapter || adapter.__ipadRawPh056Installed) return adapter;
  adapter.__ipadRawPh056Installed = true;
  adapter.__ipadLastFullRender056 = 0;
  adapter.__suppressIpadWrite056 = false;
  adapter.__originalSetStateIfChanged056 = adapter.setStateIfChanged.bind(adapter);

  adapter.setStateIfChanged = async function guardedSetStateIfChanged(id, value, ack = true) {
    if (id === IPAD_STATE && adapter.__suppressIpadWrite056) return false;
    return adapter.__originalSetStateIfChanged056(id, value, ack);
  };

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const now = Date.now();
      const editing = await isEditing(adapter);
      const throttled = adapter.__ipadLastFullRender056 > 0 && (now - adapter.__ipadLastFullRender056) < IPAD_RENDER_INTERVAL_MS;
      const suppressIpad = editing || throttled;

      adapter.__suppressIpadWrite056 = suppressIpad;
      let result;
      try {
        result = await originalRender(...args);
      } finally {
        adapter.__suppressIpadWrite056 = false;
      }

      if (!suppressIpad) {
        try {
          const [state, rawPh] = await Promise.all([
            adapter.getStateAsync(IPAD_STATE),
            getRawPh(adapter)
          ]);
          const current = String((state && state.val) || '');
          const next = patchIpad(current, adapter.namespace, rawPh);
          if (next && next !== current) await adapter.__originalSetStateIfChanged056(IPAD_STATE, next, true);
          adapter.__ipadLastFullRender056 = Date.now();
        } catch (error) {
          if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {
            adapter.log.warn('[IPAD-MINI] PH803-Rohwert konnte nicht ergänzt werden: ' + (error.message || error));
          }
        }
      }

      await patchOtherVersions(adapter);
      return result;
    };
  }

  adapter.on('ready', () => {
    ensureEditingState(adapter).catch(() => {});
    try { adapter.subscribeStates(EDIT_STATE); } catch {}
  });

  adapter.on('stateChange', (id, state) => {
    if (id !== `${adapter.namespace}.${EDIT_STATE}` || !state || adapter.isShuttingDown) return;
    if (boolValue(state.val)) return;

    adapter.__ipadLastFullRender056 = 0;
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        await adapter.forceImmediateRender();
      } catch {}
    }, 350));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

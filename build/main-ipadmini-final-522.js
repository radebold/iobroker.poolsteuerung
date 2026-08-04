'use strict';

// 0.5.22: Zentraler Lauftext für Tablet-, Mobile- und iPad-mini-VIS.
// Steuerung ausschließlich über:
//   poolsteuerung.0.vis.messageText
//   poolsteuerung.0.vis.messageLevel = info | warning | error
const createBase = require('./main-ipadmini-final-521.js');

const VERSION = 'v0.5.22';
const MESSAGE_TEXT_ID = 'vis.messageText';
const MESSAGE_LEVEL_ID = 'vis.messageLevel';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeLevel(value) {
  const level = String(value || '').trim().toLowerCase();
  if (['error', 'err', 'alarm', 'kritisch', 'critical'].includes(level)) return 'error';
  if (['warning', 'warn', 'achtung', 'gelb'].includes(level)) return 'warning';
  return 'info';
}

function stripMessageBanner(value) {
  return patchVersion(value)
    .replace(/<style\b[^>]*data-pool-message-style="1"[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<div\b[^>]*data-pool-message-banner="1"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '')
    .replace(/<div\b[^>]*data-pool-message-banner="1"[^>]*>[\s\S]*?<\/div>/gi, '');
}

function buildMessageStyle() {
  return `<style data-pool-message-style="1">
.pool-message-banner{position:fixed;z-index:2147483000;top:6px;left:50%;transform:translateX(-50%);width:min(92vw,920px);height:30px;border-radius:11px;overflow:hidden;pointer-events:none;box-sizing:border-box;border:1px solid rgba(255,255,255,.20);box-shadow:0 5px 18px rgba(0,0,0,.28);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-family:Arial,Helvetica,sans-serif}
.pool-message-banner.info{background:rgba(25,104,180,.94);color:#fff}
.pool-message-banner.warning{background:rgba(217,119,6,.96);color:#fff}
.pool-message-banner.error{background:rgba(190,32,32,.97);color:#fff}
.pool-message-track{position:relative;width:100%;height:100%;overflow:hidden;display:flex;align-items:center}
.pool-message-text{display:inline-block;white-space:nowrap;width:max-content;min-width:100%;padding:0 18px;box-sizing:border-box;font-size:13px;font-weight:900;line-height:30px;letter-spacing:.01em;animation:poolMessageScroll var(--pool-msg-duration,14s) linear infinite;will-change:transform}
@keyframes poolMessageScroll{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}
@media(max-width:600px){.pool-message-banner{top:4px;width:calc(100vw - 10px);height:26px;border-radius:9px}.pool-message-text{font-size:11px;line-height:26px;padding:0 12px}}
@media(prefers-reduced-motion:reduce){.pool-message-text{animation-duration:30s}}
</style>`;
}

function patchMessageBanner(value, text, level) {
  let html = stripMessageBanner(value);
  const message = String(text == null ? '' : text).trim();
  if (!html || !message) return html;

  const normalizedLevel = normalizeLevel(level);
  const icon = normalizedLevel === 'error' ? '⛔' : normalizedLevel === 'warning' ? '⚠️' : 'ℹ️';
  const duration = Math.max(11, Math.min(36, 9 + message.length * 0.16));
  const style = buildMessageStyle();
  const banner = `<div class="pool-message-banner ${normalizedLevel}" data-pool-message-banner="1" role="status" aria-live="polite" style="--pool-msg-duration:${duration.toFixed(1)}s"><div class="pool-message-track"><span class="pool-message-text">${icon}&nbsp;&nbsp;${escapeHtml(message)}</span></div></div>`;

  html = html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : `${style}${html}`;
  if (/<body\b[^>]*>/i.test(html)) {
    html = html.replace(/(<body\b[^>]*>)/i, `$1${banner}`);
  } else {
    html = `${banner}${html}`;
  }
  return html;
}

function localId(adapter, id) {
  const full = String(id || '');
  const prefix = `${adapter.namespace}.`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

function install(adapter) {
  if (!adapter || adapter.__messageBanner522Installed) return adapter;
  adapter.__messageBanner522Installed = true;

  let lastText = '';
  let lastLevel = 'info';
  let patchBusy = false;
  let patchAgain = false;

  async function readMessage() {
    const [textState, levelState] = await Promise.all([
      adapter.getStateAsync(MESSAGE_TEXT_ID),
      adapter.getStateAsync(MESSAGE_LEVEL_ID)
    ]);
    lastText = String((textState && textState.val) || '').trim();
    lastLevel = normalizeLevel(levelState && levelState.val);
    return { text: lastText, level: lastLevel };
  }

  async function patchExistingStates() {
    if (patchBusy) {
      patchAgain = true;
      return;
    }
    patchBusy = true;
    try {
      const message = await readMessage();
      for (const id of VIS_STATES) {
        try {
          const state = await adapter.getStateAsync(id);
          const current = String((state && state.val) || '');
          if (!current) continue;
          const next = patchMessageBanner(current, message.text, message.level);
          if (next !== current) await adapter.setStateIfChanged(id, next, true);
        } catch (error) {
          if (!adapter.isDbClosedError(error) && adapter.config && adapter.config.debugMode && adapter.log) {
            adapter.log.debug(`[VIS-MELDUNG] ${id}: ${error.message || error}`);
          }
        }
      }
    } finally {
      patchBusy = false;
      if (patchAgain && !adapter.isShuttingDown) {
        patchAgain = false;
        const handle = adapter.trackTimeout(setTimeout(async () => {
          adapter.pendingTimeouts.delete(handle);
          await patchExistingStates();
        }, 80));
      }
    }
  }

  // Bei jedem regulären Vollrender wird der aktuelle Lauftext wieder eingesetzt.
  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates();
      return result;
    };
  }

  adapter.on('stateChange', async (id, state) => {
    if (adapter.isShuttingDown || !state) return;
    const normalized = localId(adapter, id);
    if (normalized !== MESSAGE_TEXT_ID && normalized !== MESSAGE_LEVEL_ID) return;
    const nextText = normalized === MESSAGE_TEXT_ID ? String(state.val || '').trim() : lastText;
    const nextLevel = normalized === MESSAGE_LEVEL_ID ? normalizeLevel(state.val) : lastLevel;
    if (nextText === lastText && nextLevel === lastLevel) return;
    lastText = nextText;
    lastLevel = nextLevel;
    await patchExistingStates();
  });

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await adapter.ensureState(MESSAGE_TEXT_ID, 'string', 'text', '', true);
        await adapter.ensureState(MESSAGE_LEVEL_ID, 'string', 'text', 'info', true);
        try { adapter.subscribeStates(MESSAGE_TEXT_ID); } catch {}
        try { adapter.subscribeStates(MESSAGE_LEVEL_ID); } catch {}
        await readMessage();
        await patchExistingStates();
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) adapter.log.error(`[VIS-MELDUNG] Initialisierung fehlgeschlagen: ${error.message || error}`);
      }
    }, 1000));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

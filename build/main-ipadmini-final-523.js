'use strict';

// 0.5.23: Lauftext auf iPad Mini sichtbar + Schrift mindestens verdoppelt.
// Steuerung:
//   poolsteuerung.0.vis.messageText
//   poolsteuerung.0.vis.messageLevel = info | warning | error
// Wichtig: Basis direkt 0.5.21, damit die fehlerhafte 0.5.22-Banner-Schicht
// nicht zusätzlich aktiv bleibt.
const createBase = require('./main-ipadmini-final-521.js');

const VERSION = 'v0.5.23';
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
  let html = patchVersion(value);
  if (!html) return html;

  // 0.5.23 Marker sauber entfernen.
  html = html.replace(/<!--POOL-MESSAGE-523-START-->[\s\S]*?<!--POOL-MESSAGE-523-END-->/gi, '');

  // Alte 0.5.22 Banner/Styles entfernen.
  html = html.replace(/<style\b[^>]*data-pool-message-style="1"[^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<div\b[^>]*data-pool-message-banner="1"[^>]*>[\s\S]*?<span\b[^>]*class="pool-message-text"[^>]*>[\s\S]*?<\/span>\s*<\/div>\s*<\/div>/gi, '');
  return html;
}

function buildMessageStyle() {
  return `<style data-pool-message-style="1">
.pool-message-banner{position:fixed;z-index:2147483646;top:7px;left:50%;transform:translateX(-50%);width:min(96vw,1120px);height:52px;border-radius:14px;overflow:hidden;pointer-events:none;box-sizing:border-box;border:2px solid rgba(255,255,255,.24);box-shadow:0 7px 24px rgba(0,0,0,.38);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
.pool-message-banner.info{background:rgba(25,104,180,.97);color:#fff}
.pool-message-banner.warning{background:rgba(217,119,6,.98);color:#fff}
.pool-message-banner.error{background:rgba(190,32,32,.98);color:#fff}
.pool-message-track{position:relative;width:100%;height:100%;overflow:hidden;display:flex;align-items:center}
.pool-message-text{display:inline-block;white-space:nowrap;width:max-content;min-width:100%;padding:0 24px;box-sizing:border-box;font-size:26px;font-weight:900;line-height:48px;letter-spacing:.01em;text-shadow:0 1px 2px rgba(0,0,0,.35);animation:poolMessageScroll var(--pool-msg-duration,16s) linear infinite;will-change:transform}
@keyframes poolMessageScroll{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}
@media(max-width:600px){.pool-message-banner{top:5px;width:calc(100vw - 10px);height:44px;border-radius:11px}.pool-message-text{font-size:22px;line-height:40px;padding:0 16px}}
@media(prefers-reduced-motion:reduce){.pool-message-text{animation-duration:32s}}
</style>`;
}

function patchMessageBanner(value, text, level) {
  let html = stripMessageBanner(value);
  const message = String(text == null ? '' : text).trim();
  if (!html || !message) return html;

  const normalizedLevel = normalizeLevel(level);
  const icon = normalizedLevel === 'error' ? '⛔' : normalizedLevel === 'warning' ? '⚠️' : 'ℹ️';
  // Wegen der größeren Schrift etwas langsamer als in 0.5.22.
  const duration = Math.max(14, Math.min(46, 11 + message.length * 0.20));
  const style = buildMessageStyle();
  const banner = `<!--POOL-MESSAGE-523-START--><div class="pool-message-banner ${normalizedLevel}" data-pool-message-banner="1" role="status" aria-live="polite" style="--pool-msg-duration:${duration.toFixed(1)}s"><div class="pool-message-track"><span class="pool-message-text">${icon}&nbsp;&nbsp;${escapeHtml(message)}</span></div></div><!--POOL-MESSAGE-523-END-->`;

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
  if (!adapter || adapter.__messageBanner523Installed) return adapter;
  adapter.__messageBanner523Installed = true;

  let lastText = '';
  let lastLevel = 'info';
  let patchBusy = false;
  let patchAgain = false;

  async function ensureMessageStates() {
    await adapter.ensureState(MESSAGE_TEXT_ID, 'string', 'text', '', true);
    await adapter.ensureState(MESSAGE_LEVEL_ID, 'string', 'text', 'info', true);
  }

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
            adapter.log.debug(`[VIS-MELDUNG 0.5.23] ${id}: ${error.message || error}`);
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
        }, 100));
      }
    }
  }

  // Nach jedem Vollrender immer zuletzt patchen. Das ist speziell für iPad Mini wichtig,
  // weil dessen Renderer eine eigene vollflächige Ebene erzeugt.
  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates();
      return result;
    };
  }

  adapter.on('stateChange', (id, state) => {
    if (adapter.isShuttingDown || !state) return;
    const normalized = localId(adapter, id);
    if (normalized !== MESSAGE_TEXT_ID && normalized !== MESSAGE_LEVEL_ID) return;

    // Kurze Verzögerung stellt sicher, dass alle tieferen VIS-Renderer zuerst fertig sind.
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      await patchExistingStates();
    }, 120));
  });

  adapter.on('ready', () => {
    const start = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(start);
      if (adapter.isShuttingDown) return;
      try {
        await ensureMessageStates();
        try { adapter.subscribeStates(MESSAGE_TEXT_ID); } catch {}
        try { adapter.subscribeStates(MESSAGE_LEVEL_ID); } catch {}
        await readMessage();
        await patchExistingStates();

        // iPad-Mini-Renderer patcht in älteren Schichten noch verzögert nach.
        // Daher nach 4 und 9 Sekunden erneut den Banner als oberste Ebene einsetzen.
        for (const delay of [4000, 9000]) {
          const h = adapter.trackTimeout(setTimeout(async () => {
            adapter.pendingTimeouts.delete(h);
            if (!adapter.isShuttingDown) await patchExistingStates();
          }, delay));
        }
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) {
          adapter.log.error(`[VIS-MELDUNG 0.5.23] Initialisierung fehlgeschlagen: ${error.message || error}`);
        }
      }
    }, 1100));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

// 0.5.37: iPad-Mini Refresh-Fix.
// WICHTIG: bewusst direkt auf 0.5.35 aufbauen und 0.5.36 ueberspringen.
// 0.5.36 setzte Render-Throttles zurueck und erzeugte dadurch sichtbare
// Voll-Refreshes/Wackeln. 0.5.37 laesst den bestehenden iPad-Throttle unangetastet.
// Ungueltige Historienpunkte werden nur einmal beim Start bereinigt.
// Der bereits vorhandene PH803W-Rohwert bleibt erhalten und wird als
// "(roh 7,50)" eindeutig gekennzeichnet.
const createBase = require('./main-ipadmini-final-535.js');

const VERSION = 'v0.5.37';
const LOCAL24H_ID = 'status.trend.ipadMiniLocal24hJson';
const TODAY_ID = 'status.trend.phTodayJson';
const IPAD_VIS_ID = 'vis.htmlIpadMini';

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function plausiblePoolPh(value) {
  const parsed = num(value);
  return parsed !== null && parsed >= 5.5 && parsed <= 9.5;
}

function parseJson(value, fallback) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '') : value;
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function filterRows(rows) {
  if (!Array.isArray(rows)) return { rows: [], removed: 0 };
  const filtered = rows.filter(row => {
    const value = num(row && row.val !== undefined ? row.val : row);
    return plausiblePoolPh(value);
  });
  return { rows: filtered, removed: rows.length - filtered.length };
}

function patchRawLabel(value) {
  let html = patchVersion(value);
  if (!html) return html;

  // Der Rohwert wird seit 0.4.56 in einem eigenen Span erzeugt.
  // Nur dessen Text aendern; keinerlei Layout-/Renderlogik anfassen.
  html = html.replace(
    /(<span\b[^>]*class="[^"]*\bph-raw\b[^"]*"[^>]*data-ph-raw="1"[^>]*>)\(\s*(?:roh\s*)?([^<()]+?)\s*\)(<\/span>)/gi,
    '$1(roh $2)$3'
  );

  // Fallback fuer abweichende Attributreihenfolge.
  html = html.replace(
    /(<span\b[^>]*data-ph-raw="1"[^>]*class="[^"]*\bph-raw\b[^"]*"[^>]*>)\(\s*(?:roh\s*)?([^<()]+?)\s*\)(<\/span>)/gi,
    '$1(roh $2)$3'
  );

  return html;
}

function install(adapter) {
  if (!adapter || adapter.__phIpadStable537Installed) return adapter;
  adapter.__phIpadStable537Installed = true;
  adapter.__phIpadStable537HistoryCleaned = false;

  async function cleanHistoryOnce() {
    if (adapter.__phIpadStable537HistoryCleaned || adapter.isShuttingDown) return 0;
    adapter.__phIpadStable537HistoryCleaned = true;

    let removed = 0;

    try {
      const state = await adapter.getStateAsync(LOCAL24H_ID);
      const data = parseJson(state && state.val, {});
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const filtered = filterRows(data.ph);
        if (filtered.removed > 0) {
          data.ph = filtered.rows;
          await adapter.setStateAsync(LOCAL24H_ID, JSON.stringify(data), true);
          removed += filtered.removed;
        }
      }
    } catch {}

    try {
      const state = await adapter.getStateAsync(TODAY_ID);
      const rows = parseJson(state && state.val, []);
      if (Array.isArray(rows)) {
        const filtered = filterRows(rows);
        if (filtered.removed > 0) {
          await adapter.setStateAsync(TODAY_ID, JSON.stringify(filtered.rows), true);
          removed += filtered.removed;
        }
      }
    } catch {}

    if (removed > 0 && adapter.log) {
      adapter.log.error(`[PH-VIS 0.5.37] ${removed} ungueltige pH-Verlaufspunkt(e) einmalig beim Start entfernt.`);
    }

    return removed;
  }

  async function patchExistingIpadState() {
    try {
      const state = await adapter.getStateAsync(IPAD_VIS_ID);
      const current = String((state && state.val) || '');
      const next = patchRawLabel(current);
      if (!next || next === current) return;

      // Die Original-Schreibfunktion aus 0.4.56 verwenden, falls vorhanden.
      // Das ist genau ein Textpatch nach einem ohnehin erfolgten Render und
      // startet keinen weiteren Renderzyklus.
      const writer = typeof adapter.__originalSetStateIfChanged056 === 'function'
        ? adapter.__originalSetStateIfChanged056.bind(adapter)
        : adapter.setStateIfChanged.bind(adapter);
      await writer(IPAD_VIS_ID, next, true);
    } catch {}
  }

  // Versionen der normalen Builder angleichen. Keine Render-Timer und keine
  // Throttle-Resets einfuehren.
  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => patchVersion(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullStable537(...args) {
      // Einmalige Datenbereinigung, aber KEIN Zuruecksetzen von
      // lastRenderSignature, lastRenderAt oder __ipadLastFullRender056.
      await cleanHistoryOnce();
      const result = await originalRender(...args);
      await patchExistingIpadState();
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      await cleanHistoryOnce();
      await patchExistingIpadState();
    }, 1200));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

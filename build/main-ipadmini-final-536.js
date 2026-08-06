'use strict';

// 0.5.36: iPad-Mini pH-Refresh und Historienbereinigung.
// - Ungueltige pH-Punkte (<5.5 oder >9.5) werden VOR dem VIS-Render entfernt.
// - Nach einer Bereinigung wird ein zweiter Render erzwungen, damit Min/Max und Kurve
//   nicht mehr aus dem alten, bereits korrumpierten Datensatz stammen.
// - Der in Klammern angezeigte PH803W-Wert wird in der iPad-Mini-VIS eindeutig als
//   Rohwert gekennzeichnet. Der grosse Wert bleibt der autoritative korrigierte pH.
const createBase = require('./main-ipadmini-final-535.js');

const VERSION = 'v0.5.36';
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

function patchIpadRawLabel(value) {
  let html = patchVersion(value);
  if (!html) return html;

  const marker = '<span class="metric-label">pH-Wert</span>';
  const labelIndex = html.indexOf(marker);
  if (labelIndex < 0) return html;

  const sectionStart = html.lastIndexOf('<section', labelIndex);
  const sectionEnd = html.indexOf('</section>', labelIndex);
  if (sectionStart < 0 || sectionEnd < 0) return html;

  let section = html.slice(sectionStart, sectionEnd + 10);

  // Nur die kleine Klammeranzeige im pH-Block anfassen. Beispiel vorher:
  // (7,55) →     nachher: (roh 7,55) →
  // Bereits gepatchte Ausgaben bleiben unveraendert.
  section = section.replace(
    /\((?!roh\s)(\d{1,2}[,.]\d{1,3})\)(\s*(?:&rarr;|→))/i,
    '(roh $1)$2'
  );

  return html.slice(0, sectionStart) + section + html.slice(sectionEnd + 10);
}

function install(adapter) {
  if (!adapter || adapter.__phIpadRefresh536Installed) return adapter;
  adapter.__phIpadRefresh536Installed = true;
  adapter.__phIpadRefresh536SecondRender = false;

  async function cleanHistoryBeforeRender() {
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
      adapter.log.error(`[PH-VIS 0.5.36] ${removed} ungueltige pH-Verlaufspunkt(e) vor dem Render entfernt.`);
    }
    return removed;
  }

  async function patchExistingIpadState() {
    try {
      const state = await adapter.getStateAsync(IPAD_VIS_ID);
      const current = String((state && state.val) || '');
      const next = patchIpadRawLabel(current);
      if (next && next !== current) {
        await adapter.setStateIfChanged(IPAD_VIS_ID, next, true);
      }
    } catch {}
  }

  // Alle normalen Builder behalten den autoritativen Wert aus 0.5.35;
  // nur Version und eindeutige Rohwert-Kennzeichnung werden ergaenzt.
  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const result = original({ ...(data || {}), adapterVersion: VERSION });
      return name === 'buildTabletHtml' ? patchIpadRawLabel(result) : patchVersion(result);
    };
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async function renderVisFullWithFreshPhHistory(...args) {
      const removed = await cleanHistoryBeforeRender();

      // Signaturen zuruecksetzen, damit ein echter Neuaufbau erfolgt.
      if (removed > 0) {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (Object.prototype.hasOwnProperty.call(adapter, '__ipadLastFullRender056')) {
          adapter.__ipadLastFullRender056 = 0;
        }
      }

      const result = await originalRender(...args);
      await patchExistingIpadState();

      // Wenn wir alte Punkte entfernt haben, einmal direkt mit dem bereinigten
      // Datensatz neu rendern. Rekursion ist durch das Flag ausgeschlossen.
      if (removed > 0 && !adapter.__phIpadRefresh536SecondRender) {
        adapter.__phIpadRefresh536SecondRender = true;
        try {
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
          if (Object.prototype.hasOwnProperty.call(adapter, '__ipadLastFullRender056')) {
            adapter.__ipadLastFullRender056 = 0;
          }
          await originalRender(...args);
          await patchExistingIpadState();
        } finally {
          adapter.__phIpadRefresh536SecondRender = false;
        }
      }

      return result;
    };
  }

  adapter.on('ready', () => {
    for (const delay of [800, 2500, 6000]) {
      const handle = adapter.trackTimeout(setTimeout(async () => {
        adapter.pendingTimeouts.delete(handle);
        if (adapter.isShuttingDown) return;
        const removed = await cleanHistoryBeforeRender();
        if (removed > 0) {
          adapter.lastRenderSignature = '';
          adapter.lastRenderAt = 0;
        }
        try {
          if (typeof adapter.forceImmediateRender === 'function') {
            await adapter.forceImmediateRender();
          } else if (typeof adapter.renderVisFull === 'function') {
            await adapter.renderVisFull();
          }
        } catch {}
        await patchExistingIpadState();
      }, delay));
    }
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

'use strict';

// 0.5.21: Konfigurierbares Leergewicht/Tara des pH-Minus-Kanisters.
// Einzige Quelle ist adapter.config.phCanisterTareKg aus der Admin-UI.
// Alle VIS zeigen neben dem Nettogewicht den tatsächlich verwendeten Tara-Wert.
const createBase = require('./main-ipadmini-final-520.js');

const VERSION = 'v0.5.21';
const VIS_STATES = ['vis.htmlTablet', 'vis.widgetTablet', 'vis.htmlPhone', 'vis.widgetPhone', 'vis.htmlIpadMini'];

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function getConfiguredTare(adapter) {
  const parsed = num(adapter && adapter.config ? adapter.config.phCanisterTareKg : null);
  return parsed === null ? 0 : Math.max(0, parsed);
}

function formatTare(value) {
  return Number(value || 0).toFixed(3);
}

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function patchCanisterDisplay(value, tareKg) {
  let html = patchVersion(value);
  if (!html) return html;

  const tareText = formatTare(tareKg);

  // Jede sichtbare Netto-Gewichtsangabe erhält den tatsächlich konfigurierten Tara-Wert.
  // Vorhandene Tara-Suffixe werden ersetzt, damit nach einer Konfigurationsänderung
  // niemals ein alter Wert in der VIS stehen bleibt.
  html = html.replace(
    /(\d+(?:[.,]\d+)?)\s*kg\s*netto(?:\s*[·|\-]\s*Tara\s*\d+(?:[.,]\d+)?\s*kg)?/gi,
    (_match, net) => `${net} kg netto · Tara ${tareText} kg`
  );

  // Auch Detail-/Quelltexte mit „x kg Tara“ auf den aktuellen Konfigurationswert bringen.
  html = html.replace(
    /(?:\d+(?:[.,]\d+)?)\s*kg\s*Tara/gi,
    `${tareText} kg Tara`
  );

  return html;
}

function enrichData(adapter, data) {
  const tareKg = getConfiguredTare(adapter);
  const next = { ...(data || {}), adapterVersion: VERSION };

  if (next.phCanister && typeof next.phCanister === 'object') {
    next.phCanister = { ...next.phCanister };
    next.phCanister.tareKg = tareKg;
    next.phCanister.tareDisplay = formatTare(tareKg);
    if (typeof next.phCanister.source === 'string') {
      next.phCanister.source = next.phCanister.source.replace(
        /\d+(?:[.,]\d+)?\s*kg\s*Tara/gi,
        `${formatTare(tareKg)} kg Tara`
      );
    }
  }

  return next;
}

function install(adapter) {
  if (!adapter || adapter.__phCanisterTare521Installed) return adapter;
  adapter.__phCanisterTare521Installed = true;

  // Zentraler Konfigurationspfad: Alle Berechnungen bekommen das Leergewicht ausschließlich
  // aus der Admin-UI. Kein fest verdrahteter Kanisterwert in der Runtime.
  if (typeof adapter.getPhCanisterConfig === 'function') {
    const originalGetConfig = adapter.getPhCanisterConfig.bind(adapter);
    adapter.getPhCanisterConfig = function getPhCanisterConfigConfiguredTare() {
      const cfg = originalGetConfig() || {};
      return { ...cfg, tareKg: getConfiguredTare(adapter) };
    };
  }

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => {
      const tareKg = getConfiguredTare(adapter);
      return patchCanisterDisplay(original(enrichData(adapter, data)), tareKg);
    };
  }

  async function syncTareStates() {
    const tareKg = getConfiguredTare(adapter);
    try {
      await adapter.ensureState('status.phCanister.tareWeightKg', 'number', 'value', tareKg, false);
      await adapter.setStateIfChanged('status.phCanister.tareWeightKg', tareKg, true);
      await adapter.ensureState('status.debug.phCanisterTareSource', 'string', 'text', '', false);
      await adapter.setStateIfChanged(
        'status.debug.phCanisterTareSource',
        `Admin-UI phCanisterTareKg = ${formatTare(tareKg)} kg · Netto = Brutto - Tara`,
        true
      );
    } catch {}
  }

  async function patchExistingStates() {
    const tareKg = getConfiguredTare(adapter);
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = patchCanisterDisplay(current, tareKg);
        if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
      } catch {}
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await syncTareStates();
      await patchExistingStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        await syncTareStates();
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
        await patchExistingStates();
      } catch {}
    }, 900));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

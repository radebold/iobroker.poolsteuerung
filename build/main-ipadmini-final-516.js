'use strict';

// 0.5.16: optische Glättung der VIS-Verlaufskurven.
// Die Messwerte bleiben unverändert; nur geradlinige SVG-Segmente werden
// in begrenzte kubische Bézier-Kurven umgewandelt.
const createBase = require('./main-ipadmini-final-515.js');

const VERSION = 'v0.5.16';
const VIS_STATES = [
  'vis.htmlTablet',
  'vis.widgetTablet',
  'vis.htmlPhone',
  'vis.widgetPhone',
  'vis.htmlIpadMini'
];

function patchVersion(value) {
  return String(value || '').replace(/v\d+\.\d+\.\d+(?:[-+][\w.-]+)?/g, VERSION);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseCoordinatePairs(value) {
  const numbers = String(value || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const points = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    const x = Number(numbers[index]);
    const y = Number(numbers[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    points.push({ x, y });
  }
  return points;
}

function looksLikeChart(points) {
  if (!Array.isArray(points) || points.length < 4) return false;
  const xs = points.map(point => point.x);
  const xRange = Math.max(...xs) - Math.min(...xs);
  return xRange >= 40 || points.length >= 9;
}

function smoothPath(points) {
  if (!looksLikeChart(points)) return '';
  const factor = 0.12;
  let path = `M ${round1(points[0].x)} ${round1(points[0].y)}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] || points[index];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[index + 2] || p2;
    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);

    const c1x = clamp(p1.x + (p2.x - p0.x) * factor, minX, maxX);
    const c1y = clamp(p1.y + (p2.y - p0.y) * factor, minY, maxY);
    const c2x = clamp(p2.x - (p3.x - p1.x) * factor, minX, maxX);
    const c2y = clamp(p2.y - (p3.y - p1.y) * factor, minY, maxY);

    path += ` C ${round1(c1x)} ${round1(c1y)} ${round1(c2x)} ${round1(c2y)} ${round1(p2.x)} ${round1(p2.y)}`;
  }

  return path;
}

function smoothSvgPaths(value) {
  let html = patchVersion(value);
  if (!html) return html;

  html = html.replace(/<path\b([^>]*?)\bd="([^"]+)"([^>]*)>/gi, (tag, before, d, after) => {
    if (/data-pool-smoothed="1"/i.test(tag)) return tag;
    if (!/\bstroke\s*=/i.test(tag)) return tag;
    if (/[CQSA]/i.test(d)) return tag;
    const lineCount = (d.match(/[L]/gi) || []).length;
    if (lineCount < 3) return tag;
    const points = parseCoordinatePairs(d);
    const smoothed = smoothPath(points);
    if (!smoothed) return tag;
    return `<path${before}d="${smoothed}"${after} data-pool-smoothed="1">`;
  });

  html = html.replace(/<polyline\b([^>]*?)\bpoints="([^"]+)"([^>]*?)(?:\/>|>\s*<\/polyline>)/gi, (tag, before, pointText, after) => {
    if (!/\bstroke\s*=/i.test(tag)) return tag;
    const points = parseCoordinatePairs(pointText);
    const smoothed = smoothPath(points);
    if (!smoothed) return tag;
    return `<path${before}d="${smoothed}"${after} data-pool-smoothed="1"></path>`;
  });

  return html;
}

function install(adapter) {
  if (!adapter || adapter.__curveSmoothing516Installed) return adapter;
  adapter.__curveSmoothing516Installed = true;

  for (const name of ['buildTabletHtml', 'buildTabletWidget', 'buildPhoneHtml', 'buildPhoneWidget']) {
    if (typeof adapter[name] !== 'function') continue;
    const original = adapter[name].bind(adapter);
    adapter[name] = data => smoothSvgPaths(original({ ...(data || {}), adapterVersion: VERSION }));
  }

  async function patchExistingStates() {
    for (const id of VIS_STATES) {
      try {
        const state = await adapter.getStateAsync(id);
        const current = String((state && state.val) || '');
        const next = smoothSvgPaths(current);
        if (next && next !== current) await adapter.setStateIfChanged(id, next, true);
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.config && adapter.config.debugMode && adapter.log) {
          adapter.log.debug(`[VIS] Kurvenglättung ${id}: ${error.message || error}`);
        }
      }
    }
  }

  if (typeof adapter.renderVisFull === 'function') {
    const originalRender = adapter.renderVisFull.bind(adapter);
    adapter.renderVisFull = async (...args) => {
      const result = await originalRender(...args);
      await patchExistingStates();
      return result;
    };
  }

  adapter.on('ready', () => {
    const handle = adapter.trackTimeout(setTimeout(async () => {
      adapter.pendingTimeouts.delete(handle);
      if (adapter.isShuttingDown) return;
      try {
        adapter.lastRenderSignature = '';
        adapter.lastRenderAt = 0;
        if (typeof adapter.forceImmediateRender === 'function') await adapter.forceImmediateRender();
        await patchExistingStates();
      } catch (error) {
        if (!adapter.isDbClosedError(error) && adapter.log) adapter.log.warn(`[VIS] Kurvenglättung 0.5.16: ${error.message || error}`);
      }
      if (adapter.log && typeof adapter.log.info === 'function') {
        adapter.log.info('[VIS] v0.5.16: Temperatur-, pH- und ORP-Verlaufskurven optisch geglättet.');
      }
    }, 1800));
  });

  return adapter;
}

function createAdapter(options = {}) {
  return install(createBase(options));
}

if (require.main !== module) module.exports = createAdapter;
else createAdapter();

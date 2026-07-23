'use strict';

const createBaseAdapter = require('./main.js');

const FAST_FEEDBACK_SCRIPT = String.raw`<script data-pool-fast-feedback="1">
(function(){
  if (window.__poolFastFeedbackInstalled) return;
  window.__poolFastFeedbackInstalled = true;

  function desiredLabel(el, desired) {
    if (el.classList.contains('js-standby-btn')) return desired ? 'AKTIV' : 'AUS';
    if (el.classList.contains('js-auto-btn')) return desired ? 'AKTIV' : 'AUS';
    return desired ? 'EIN' : 'AUS';
  }

  function applyOptimisticState(el, desired) {
    if (!el || !el.isConnected) return;
    const label = desiredLabel(el, desired);
    el.dataset.current = desired ? '1' : '0';
    el.dataset.fastExpected = desired ? '1' : '0';

    el.classList.toggle('is-on', desired);
    el.classList.toggle('is-off', !desired);
    el.classList.toggle('status-on', desired);
    el.classList.toggle('status-off', !desired);
    el.classList.toggle('on', desired);
    el.classList.toggle('off', !desired);

    const stateNodes = el.querySelectorAll('.action-state,.auto-toggle-state,.ps-btn-state,.ps-state,.pill');
    stateNodes.forEach(function(node){
      const text = node.classList.contains('pill') ? (desired ? 'EIN' : 'AUS') : label;
      node.textContent = text + ' …';
      node.dataset.oldText = text;
      node.classList.toggle('on', desired);
      node.classList.toggle('off', !desired);
    });

    if (el.classList.contains('ps-mode')) {
      el.textContent = desired ? 'STANDBY …' : 'NORMAL …';
    }

    if (el.classList.contains('js-standby-btn')) {
      const badge = el.querySelector('.sync-badge.sync-inline');
      if (badge) {
        badge.textContent = desired ? 'STANDBY aktiv …' : 'Normalbetrieb …';
        badge.classList.toggle('ok', desired);
        badge.classList.toggle('warn', !desired);
      }
    }

    window.setTimeout(function(){
      if (!el || !el.isConnected) return;
      el.dataset.pending = '0';
      el.classList.remove('is-pending');
      el.style.pointerEvents = el.dataset.oldPointerEvents || '';
      el.style.background = el.dataset.oldBackground || '';

      stateNodes.forEach(function(node){
        if (node && node.isConnected) node.textContent = node.dataset.oldText || label;
      });
      if (el.classList.contains('ps-mode')) {
        el.textContent = desired ? 'STANDBY' : 'NORMAL';
      }
      if (el.classList.contains('js-standby-btn')) {
        const badge = el.querySelector('.sync-badge.sync-inline');
        if (badge) badge.textContent = desired ? 'STANDBY aktiv' : 'Normalbetrieb';
      }
    }, 1800);
  }

  function prepareFastFeedback(ev) {
    const target = ev && ev.target && typeof ev.target.closest === 'function'
      ? ev.target.closest('.js-device-btn,.js-auto-btn,.js-standby-btn')
      : null;
    if (!target) return;

    const now = Date.now();
    const last = Number(target.dataset.fastFeedbackTapTs || 0);
    if (now - last < 700) return;
    target.dataset.fastFeedbackTapTs = String(now);

    const desired = target.dataset.current !== '1';
    window.setTimeout(function(){ applyOptimisticState(target, desired); }, 0);
  }

  document.addEventListener('touchend', prepareFastFeedback, true);
  document.addEventListener('click', prepareFastFeedback, true);
})();
</script>`;

function injectFastFeedback(html) {
  const value = String(html || '');
  if (!value || value.includes('data-pool-fast-feedback="1"')) return value;
  if (value.includes('</body>')) return value.replace('</body>', FAST_FEEDBACK_SCRIPT + '</body>');
  return value + FAST_FEEDBACK_SCRIPT;
}

function installFastActuatorFeedback(adapter) {
  if (!adapter || adapter.__fastActuatorFeedbackInstalled) return adapter;
  adapter.__fastActuatorFeedbackInstalled = true;

  // Die bisherigen Wartewerte sind Zeitpunkte, keine aufzuaddierenden Pausen.
  // Dadurch sinkt die maximale Zigbee-Bestätigungszeit von 3,6 s auf 1,5 s
  // und bei Single-Write-Geräten von 9,0 s auf 3,5 s.
  adapter.waitForBoolState = async function waitForBoolStateFast(id, expected, waits = [500, 1000, 1500, 2500]) {
    const checkpoints = Array.from(new Set((Array.isArray(waits) ? waits : [])
      .map(Number)
      .filter(value => Number.isFinite(value) && value >= 0)))
      .sort((a, b) => a - b);

    let elapsed = 0;
    for (const checkpoint of checkpoints) {
      const delay = Math.max(0, checkpoint - elapsed);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      elapsed = checkpoint;
      try {
        if ((await this.getBool(id)) === expected) return true;
      } catch {}
    }
    return false;
  };

  ['buildTabletHtml', 'buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget'].forEach(methodName => {
    if (typeof adapter[methodName] !== 'function') return;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchedVisBuilder(data) {
      return injectFastFeedback(original(data));
    };
  });

  try {
    adapter.log.info('[FAST-ACTUATOR] Sofortige Button-Rückmeldung und verkürzte Readback-Wartezeiten aktiv');
  } catch {}

  return adapter;
}

function createAdapter(options = {}) {
  return installFastActuatorFeedback(createBaseAdapter(options));
}

if (require.main !== module) {
  module.exports = createAdapter;
} else {
  createAdapter();
}

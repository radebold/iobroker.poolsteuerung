'use strict';

const createBaseAdapter = require('./main.js');

const ADAPTER_VERSION = 'v0.4.3';
const REQUEST_TIMEOUT_MS = 30000;
const READBACK_DELAYS_MS = [250, 800, 1600, 3000, 5000, 8000, 12000, 18000, 24000];

const FAST_FEEDBACK_SCRIPT = String.raw`<script data-pool-fast-feedback="2">
(function(){
  if (window.__poolFastFeedbackV2Installed) return;
  window.__poolFastFeedbackV2Installed = true;

  function desiredLabel(el, desired) {
    if (el.classList.contains('js-standby-btn')) return desired ? 'AKTIV' : 'AUS';
    if (el.classList.contains('js-auto-btn')) return desired ? 'AKTIV' : 'AUS';
    return desired ? 'EIN' : 'AUS';
  }

  function findSyncNodes(el) {
    return el ? el.querySelectorAll('.action-sync,.sync-badge') : [];
  }

  function setRequestLabel(el, startedAt) {
    const update = function(){
      if (!el || !el.isConnected) return false;
      const ageSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      findSyncNodes(el).forEach(function(node){
        node.textContent = 'REQ · ' + ageSec + 's';
        node.classList.remove('ok','bad');
        node.classList.add('warn');
      });
      return ageSec < 30;
    };
    update();
    const timer = window.setInterval(function(){
      if (!update()) window.clearInterval(timer);
    }, 1000);
  }

  function applyOptimisticState(el, desired) {
    if (!el || !el.isConnected) return;
    const label = desiredLabel(el, desired);
    const startedAt = Date.now();
    el.dataset.current = desired ? '1' : '0';
    el.dataset.fastExpected = desired ? '1' : '0';
    el.dataset.fastRequestStartedAt = String(startedAt);

    el.classList.toggle('is-on', desired);
    el.classList.toggle('is-off', !desired);
    el.classList.toggle('status-on', desired);
    el.classList.toggle('status-off', !desired);
    el.classList.toggle('on', desired);
    el.classList.toggle('off', !desired);

    const stateNodes = el.querySelectorAll('.action-state,.auto-toggle-state,.ps-btn-state,.ps-state,.pill');
    stateNodes.forEach(function(node){
      const text = node.classList.contains('pill') ? (desired ? 'EIN' : 'AUS') : label;
      node.textContent = text;
      node.dataset.oldText = text;
      node.classList.toggle('on', desired);
      node.classList.toggle('off', !desired);
    });

    if (el.classList.contains('ps-mode')) {
      el.textContent = desired ? 'STANDBY' : 'NORMAL';
    }

    if (el.classList.contains('js-standby-btn')) {
      const badge = el.querySelector('.sync-badge.sync-inline');
      if (badge) {
        badge.textContent = desired ? 'STANDBY aktiv' : 'Normalbetrieb';
        badge.classList.toggle('ok', desired);
        badge.classList.toggle('warn', !desired);
      }
    } else if (el.classList.contains('js-device-btn')) {
      setRequestLabel(el, startedAt);
    }

    window.setTimeout(function(){
      if (!el || !el.isConnected) return;
      el.dataset.pending = '0';
      el.classList.remove('is-pending');
      el.style.pointerEvents = el.dataset.oldPointerEvents || '';
      el.style.background = el.dataset.oldBackground || '';
    }, 900);
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
  let value = String(html || '');
  if (!value) return value;
  value = value.replace(/<script data-pool-fast-feedback="1">[\s\S]*?<\/script>/g, '');
  if (value.includes('data-pool-fast-feedback="2"')) return value;
  if (value.includes('</body>')) return value.replace('</body>', FAST_FEEDBACK_SCRIPT + '</body>');
  return value + FAST_FEEDBACK_SCRIPT;
}

function boolFromValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'on', 'ein', 'yes', 'ja'].includes(text)) return true;
  if (['false', '0', 'off', 'aus', 'no', 'nein', ''].includes(text)) return false;
  return !!value;
}

function installFastActuatorFeedback(adapter) {
  if (!adapter || adapter.__fastActuatorFeedbackInstalled) return adapter;
  adapter.__fastActuatorFeedbackInstalled = true;
  adapter.__actuatorRequests = new Map();
  adapter.__fastVisRenderActive = false;

  function getRequest(id) {
    if (!id) return null;
    return adapter.__actuatorRequests.get(String(id)) || null;
  }

  function finishRequest(id, confirmed) {
    const key = String(id || '');
    const request = adapter.__actuatorRequests.get(key);
    if (!request) return;
    if (confirmed) {
      adapter.__actuatorRequests.delete(key);
    } else {
      request.failed = true;
      request.failedAt = Date.now();
      adapter.__actuatorRequests.set(key, request);
    }
    adapter.controlTransitionUntil = Date.now() + 500;
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    try { adapter.queueRender(); } catch {}
  }

  function scheduleReadbacks(id, request) {
    if (!id || !request || request.readbacksScheduled) return;
    request.readbacksScheduled = true;
    for (const delay of READBACK_DELAYS_MS) {
      const handle = adapter.trackTimeout(setTimeout(async function(){
        adapter.pendingTimeouts.delete(handle);
        const current = adapter.__actuatorRequests.get(String(id));
        if (!current || current !== request || current.failed) return;
        try {
          if (typeof adapter.requestZigbeePowerRead === 'function') {
            await adapter.requestZigbeePowerRead(id, true);
          }
        } catch {}
        try {
          const actual = await adapter.__baseGetBool(id);
          if (actual === current.desired) finishRequest(id, true);
        } catch {}
      }, delay));
    }
    const timeoutHandle = adapter.trackTimeout(setTimeout(function(){
      adapter.pendingTimeouts.delete(timeoutHandle);
      const current = adapter.__actuatorRequests.get(String(id));
      if (current && current === request) finishRequest(id, false);
    }, REQUEST_TIMEOUT_MS));
  }

  function beginRequest(id, desired) {
    if (!id) return null;
    const key = String(id);
    const existing = adapter.__actuatorRequests.get(key);
    if (existing && !existing.failed && existing.desired === !!desired && Date.now() < existing.expiresAt) {
      scheduleReadbacks(id, existing);
      return existing;
    }
    const now = Date.now();
    const request = {
      desired: !!desired,
      startedAt: now,
      expiresAt: now + REQUEST_TIMEOUT_MS,
      failed: false,
      readbacksScheduled: false
    };
    adapter.__actuatorRequests.set(key, request);
    adapter.beginControlTransition(REQUEST_TIMEOUT_MS);
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    scheduleReadbacks(id, request);
    return request;
  }

  adapter.__baseGetBool = adapter.getBool.bind(adapter);

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
        if ((await adapter.__baseGetBool(id)) === expected) return true;
      } catch {}
    }
    return false;
  };

  adapter.getBool = async function getBoolWithPendingRequest(id) {
    const request = getRequest(id);
    if (this.__fastVisRenderActive && request && !request.failed && Date.now() < request.expiresAt) {
      return request.desired;
    }
    return this.__baseGetBool(id);
  };

  const baseForceOn = adapter.forceSwitchOnCompat.bind(adapter);
  const baseForceOff = adapter.forceSwitchOffCompat.bind(adapter);
  adapter.forceSwitchOnCompat = async function forceSwitchOnCompatFast(id) {
    beginRequest(id, true);
    return baseForceOn(id);
  };
  adapter.forceSwitchOffCompat = async function forceSwitchOffCompatFast(id) {
    beginRequest(id, false);
    return baseForceOff(id);
  };

  const baseSyncInfo = adapter.getVerifiedDeviceSyncInfo.bind(adapter);
  adapter.getVerifiedDeviceSyncInfo = async function getVerifiedDeviceSyncInfoFast(id, state, maxAgeSec = 180) {
    const request = getRequest(id);
    if (request) {
      const ageSec = Math.max(0, Math.floor((Date.now() - request.startedAt) / 1000));
      const actual = boolFromValue(state && state.val);
      const stateTs = Number((state && (state.lc || state.ts)) || 0);
      if (!request.failed && actual === request.desired && stateTs >= request.startedAt - 1000) {
        finishRequest(id, true);
        return { cls: 'ok', label: `${ageSec}s`, ageSec };
      }
      if (!request.failed && Date.now() < request.expiresAt) {
        return { cls: 'warn', label: `REQ · ${ageSec}s`, ageSec };
      }
      return { cls: 'bad', label: `FEHLT · ${ageSec}s`, ageSec };
    }
    return baseSyncInfo(id, state, maxAgeSec);
  };

  const baseRenderVisFull = adapter.renderVisFull.bind(adapter);
  adapter.renderVisFull = async function renderVisFullFast(force = false) {
    this.__fastVisRenderActive = true;
    try {
      return await baseRenderVisFull(force);
    } finally {
      this.__fastVisRenderActive = false;
    }
  };

  ['buildTabletHtml', 'buildPhoneHtml', 'buildTabletWidget', 'buildPhoneWidget'].forEach(methodName => {
    if (typeof adapter[methodName] !== 'function') return;
    const original = adapter[methodName].bind(adapter);
    adapter[methodName] = function patchedVisBuilder(data) {
      const patchedData = { ...(data || {}), adapterVersion: ADAPTER_VERSION };
      return injectFastFeedback(original(patchedData));
    };
  });

  adapter.on('stateChange', async function fastActuatorStateConfirmation(id, state) {
    if (!state || !id) return;
    const request = adapter.__actuatorRequests.get(String(id));
    if (!request || request.failed) return;
    const actual = boolFromValue(state.val);
    if (actual !== request.desired) return;
    finishRequest(id, true);
    try { await adapter.forceImmediateRender(); } catch {}
  });

  try {
    adapter.log.info('[FAST-ACTUATOR] v0.4.3: stabiler REQ-Zustand, Sekundenanzeige und aktive Zigbee-Readbacks');
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

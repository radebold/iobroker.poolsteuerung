'use strict';

const createBaseAdapter = require('./main.js');

const ADAPTER_VERSION = 'v0.4.4';
const REQUEST_TIMEOUT_MS = 12000;
const FAILURE_VISIBLE_MS = 4000;
const READBACK_DELAYS_MS = [100, 250, 500, 800, 1200, 1800, 2500, 3500, 5000, 8000, 11000];

const FAST_FEEDBACK_SCRIPT = String.raw`<script data-pool-fast-feedback="3">
(function(){
  if (window.__poolFastFeedbackV3Installed) return;
  window.__poolFastFeedbackV3Installed = true;

  function desiredLabel(el, desired) {
    if (el.classList.contains('js-standby-btn')) return desired ? 'AKTIV' : 'AUS';
    if (el.classList.contains('js-auto-btn')) return desired ? 'AKTIV' : 'AUS';
    return desired ? 'EIN' : 'AUS';
  }

  function syncNodes(el) {
    return el ? el.querySelectorAll('.action-sync,.sync-badge') : [];
  }

  function showRequestAge(el, startedAt) {
    var timer = null;
    var update = function(){
      if (!el || !el.isConnected) {
        if (timer) window.clearInterval(timer);
        return;
      }
      var ageSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      syncNodes(el).forEach(function(node){
        node.textContent = 'REQ · ' + ageSec + 's';
        node.classList.remove('ok','bad');
        node.classList.add('warn');
      });
      if (ageSec >= 12 && timer) window.clearInterval(timer);
    };
    update();
    timer = window.setInterval(update, 1000);
  }

  function applyOptimisticState(el, desired) {
    if (!el || !el.isConnected) return;
    var label = desiredLabel(el, desired);
    var startedAt = Date.now();

    el.dataset.current = desired ? '1' : '0';
    el.dataset.fastExpected = desired ? '1' : '0';
    el.dataset.fastRequestStartedAt = String(startedAt);
    el.classList.toggle('is-on', desired);
    el.classList.toggle('is-off', !desired);
    el.classList.toggle('status-on', desired);
    el.classList.toggle('status-off', !desired);
    el.classList.toggle('on', desired);
    el.classList.toggle('off', !desired);

    el.querySelectorAll('.action-state,.auto-toggle-state,.ps-btn-state,.ps-state,.pill').forEach(function(node){
      var text = node.classList.contains('pill') ? (desired ? 'EIN' : 'AUS') : label;
      node.textContent = text;
      node.dataset.oldText = text;
      node.classList.toggle('on', desired);
      node.classList.toggle('off', !desired);
    });

    if (el.classList.contains('ps-mode')) el.textContent = desired ? 'STANDBY' : 'NORMAL';

    if (el.classList.contains('js-standby-btn')) {
      var badge = el.querySelector('.sync-badge.sync-inline');
      if (badge) {
        badge.textContent = desired ? 'STANDBY aktiv' : 'Normalbetrieb';
        badge.classList.toggle('ok', desired);
        badge.classList.toggle('warn', !desired);
      }
    } else if (el.classList.contains('js-device-btn')) {
      showRequestAge(el, startedAt);
    }

    window.setTimeout(function(){
      if (!el || !el.isConnected) return;
      el.dataset.pending = '0';
      el.classList.remove('is-pending');
      el.style.pointerEvents = el.dataset.oldPointerEvents || '';
      el.style.background = el.dataset.oldBackground || '';
    }, 700);
  }

  function prepareFastFeedback(ev) {
    var target = ev && ev.target && typeof ev.target.closest === 'function'
      ? ev.target.closest('.js-device-btn,.js-auto-btn,.js-standby-btn')
      : null;
    if (!target) return;

    var now = Date.now();
    var last = Number(target.dataset.fastFeedbackTapTs || 0);
    if (now - last < 700) return;
    target.dataset.fastFeedbackTapTs = String(now);

    var desired = target.dataset.current !== '1';
    window.setTimeout(function(){ applyOptimisticState(target, desired); }, 0);
  }

  document.addEventListener('touchend', prepareFastFeedback, true);
  document.addEventListener('click', prepareFastFeedback, true);
})();
</script>`;

function injectFastFeedback(html) {
  let value = String(html || '');
  if (!value) return value;
  value = value.replace(/<script data-pool-fast-feedback="\d+">[\s\S]*?<\/script>/g, '');
  if (value.includes('data-pool-fast-feedback="3"')) return value;
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
    return id ? adapter.__actuatorRequests.get(String(id)) || null : null;
  }

  function requestActive(request) {
    return !!request && !request.failed && Date.now() < request.expiresAt;
  }

  function hasActiveRequests() {
    for (const request of adapter.__actuatorRequests.values()) {
      if (requestActive(request)) return true;
    }
    return false;
  }

  function clearRequestTimers(request) {
    if (!request || !request.timers) return;
    for (const handle of request.timers) {
      try { adapter.clearTrackedTimeout(handle); } catch {
        try { clearTimeout(handle); } catch {}
      }
    }
    request.timers.clear();
  }

  function controlStateForDevice(id) {
    if (id === adapter.config.circulationPumpSocketStateId) return 'control.device.circulation';
    if (id === adapter.config.chlorinatorSocketStateId) return 'control.device.chlorinator';
    if (id === adapter.config.phPumpSocketStateId) return 'control.device.phPump';
    if (id === adapter.config.heatpumpPowerStateId) return 'control.device.heatpump';
    return '';
  }

  async function syncConfirmedControlState(id, value) {
    const controlId = controlStateForDevice(id);
    if (!controlId) return;
    try { await adapter.setStateIfChanged(controlId, !!value, true); } catch {}
  }

  function triggerRender() {
    adapter.controlTransitionUntil = Date.now() + 500;
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    try { adapter.queueRender(); } catch {}
  }

  function finishRequest(id, confirmed) {
    const key = String(id || '');
    const request = adapter.__actuatorRequests.get(key);
    if (!request) return;

    clearRequestTimers(request);
    if (confirmed) {
      adapter.__actuatorRequests.delete(key);
    } else {
      request.failed = true;
      request.failedAt = Date.now();
      adapter.__actuatorRequests.set(key, request);
      const cleanup = adapter.trackTimeout(setTimeout(function(){
        adapter.pendingTimeouts.delete(cleanup);
        if (adapter.__actuatorRequests.get(key) === request) {
          adapter.__actuatorRequests.delete(key);
          triggerRender();
        }
      }, FAILURE_VISIBLE_MS));
      request.timers.add(cleanup);
    }
    triggerRender();
  }

  async function verifyActual(id, request) {
    if (!id || !request || adapter.__actuatorRequests.get(String(id)) !== request) return false;
    try {
      const actual = await adapter.__baseGetBool(id);
      if (actual === request.desired) {
        await syncConfirmedControlState(id, actual);
        finishRequest(id, true);
        return true;
      }
    } catch {}
    return false;
  }

  function scheduleReadbacks(id, request) {
    if (!id || !request || request.readbacksScheduled) return;
    request.readbacksScheduled = true;

    for (const delay of READBACK_DELAYS_MS) {
      const handle = adapter.trackTimeout(setTimeout(async function(){
        adapter.pendingTimeouts.delete(handle);
        request.timers.delete(handle);
        if (!requestActive(request) || adapter.__actuatorRequests.get(String(id)) !== request) return;
        try {
          if (typeof adapter.requestZigbeePowerRead === 'function') {
            await adapter.requestZigbeePowerRead(id, true);
          }
        } catch {}
        try { await new Promise(resolve => setTimeout(resolve, 80)); } catch {}
        await verifyActual(id, request);
      }, delay));
      request.timers.add(handle);
    }

    const timeoutHandle = adapter.trackTimeout(setTimeout(async function(){
      adapter.pendingTimeouts.delete(timeoutHandle);
      request.timers.delete(timeoutHandle);
      if (adapter.__actuatorRequests.get(String(id)) !== request) return;
      if (!(await verifyActual(id, request))) finishRequest(id, false);
    }, REQUEST_TIMEOUT_MS));
    request.timers.add(timeoutHandle);
  }

  function beginRequest(id, desired) {
    if (!id) return null;
    const key = String(id);
    const existing = adapter.__actuatorRequests.get(key);
    if (existing) {
      if (requestActive(existing) && existing.desired === !!desired) return existing;
      clearRequestTimers(existing);
      adapter.__actuatorRequests.delete(key);
    }

    const now = Date.now();
    const request = {
      desired: !!desired,
      startedAt: now,
      expiresAt: now + REQUEST_TIMEOUT_MS,
      failed: false,
      readbacksScheduled: false,
      timers: new Set()
    };
    adapter.__actuatorRequests.set(key, request);
    adapter.beginControlTransition(REQUEST_TIMEOUT_MS);
    adapter.lastRenderSignature = '';
    adapter.lastRenderAt = 0;
    return request;
  }

  adapter.__baseGetBool = adapter.getBool.bind(adapter);
  adapter.__baseGetStateSnapshot = adapter.getStateSnapshot.bind(adapter);

  adapter.waitForBoolState = async function waitForBoolStateFast(id, expected, waits = [300, 600, 1000, 1500]) {
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
        const actual = await adapter.__baseGetBool(id);
        if (actual === expected) {
          const request = getRequest(id);
          if (request && request.desired === expected) {
            await syncConfirmedControlState(id, actual);
            finishRequest(id, true);
          }
          return true;
        }
      } catch {}
    }
    return false;
  };

  adapter.getBool = async function getBoolWithPendingRequest(id) {
    const request = getRequest(id);
    if (this.__fastVisRenderActive && requestActive(request)) return request.desired;
    return this.__baseGetBool(id);
  };

  adapter.getStateSnapshot = async function getStateSnapshotWithPendingRequest(id) {
    const state = await this.__baseGetStateSnapshot(id);
    const request = getRequest(id);
    if (this.__fastVisRenderActive && requestActive(request)) {
      return { ...(state || {}), val: request.desired };
    }
    return state;
  };

  const baseForceOn = adapter.forceSwitchOnCompat.bind(adapter);
  const baseForceOff = adapter.forceSwitchOffCompat.bind(adapter);

  adapter.forceSwitchOnCompat = async function forceSwitchOnCompatFast(id) {
    const request = beginRequest(id, true);
    const result = await baseForceOn(id);
    if (getRequest(id) === request && !(await verifyActual(id, request))) scheduleReadbacks(id, request);
    return result;
  };

  adapter.forceSwitchOffCompat = async function forceSwitchOffCompatFast(id) {
    const request = beginRequest(id, false);
    const result = await baseForceOff(id);
    if (getRequest(id) === request && !(await verifyActual(id, request))) scheduleReadbacks(id, request);
    return result;
  };

  adapter.getVerifiedDeviceSyncInfo = async function getVerifiedDeviceSyncInfoFast(id, state, maxAgeSec = 180) {
    const request = getRequest(id);
    const actual = boolFromValue(state && state.val);

    if (request) {
      const ageSec = Math.max(0, Math.floor((Date.now() - request.startedAt) / 1000));
      if (!request.failed && actual === request.desired) {
        await syncConfirmedControlState(id, actual);
        finishRequest(id, true);
        return { cls: 'ok', label: `${ageSec}s`, ageSec };
      }
      if (requestActive(request)) return { cls: 'warn', label: `REQ · ${ageSec}s`, ageSec };
      return { cls: 'bad', label: `FEHLT · ${ageSec}s`, ageSec };
    }

    return this.getDeviceSyncInfo(state, maxAgeSec);
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

  const baseForceImmediateRender = adapter.forceImmediateRender.bind(adapter);
  adapter.forceImmediateRender = async function forceImmediateRenderFast() {
    if (hasActiveRequests()) {
      this.lastRenderSignature = '';
      this.lastRenderAt = 0;
      return this.renderVis(true);
    }
    return baseForceImmediateRender();
  };

  const baseQueueDelayedRefresh = adapter.queueDelayedRefresh.bind(adapter);
  adapter.queueDelayedRefresh = function queueDelayedRefreshFast(delayMs = 1800) {
    if (!hasActiveRequests()) return baseQueueDelayedRefresh(delayMs);
    const waitMs = Math.max(250, Math.min(Number(delayMs) || 500, 600));
    const handle = this.trackTimeout(setTimeout(() => {
      this.pendingTimeouts.delete(handle);
      if (hasActiveRequests()) this.queueDelayedRefresh(500);
      else baseQueueDelayedRefresh(0);
    }, waitMs));
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
    const request = getRequest(id);
    if (!request || request.failed) return;
    const actual = boolFromValue(state.val);
    if (actual !== request.desired) return;

    await syncConfirmedControlState(id, actual);
    finishRequest(id, true);
    try { await adapter.forceImmediateRender(); } catch {}
  });

  try {
    adapter.log.info('[FAST-ACTUATOR] v0.4.4: Bestätigung ausschließlich über Power 0/1, kein Zeitstempel-Zwang');
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

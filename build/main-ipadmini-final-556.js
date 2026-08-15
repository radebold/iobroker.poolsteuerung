'use strict';

// 0.5.56: frei konfigurierbare Texte fuer Wasserstandsalarm/Entwarnung.
// VIS und restliche Regelung bleiben unveraendert auf Basis 0.5.55.
const createBase = require('./main-ipadmini-final-554.js');

const DEFAULT_SENSOR = 'sonoff.0.TasmotaZB.ZbReceived_0xD61C_ZoneStatusChange';
const LOW_STATE_ID = 'status.waterLevel.low';
const VALUE_STATE_ID = 'status.waterLevel.sensorValue';
const LAST_ALERT_ID = 'status.waterLevel.lastAlert';
const DEBUG_ID = 'status.debug.waterLevelAlert556';

const DEFAULT_LOW_TEXT = 'Poolsteuerung: Wasserstand zu niedrig! Bitte Pool-Wasserstand prüfen.';
const DEFAULT_OK_TEXT = 'Poolsteuerung: Wasserstand wieder OK.';

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function waitSendTo(adapter, instance, command, payload) {
  if (!instance) return Promise.resolve(false);
  if (typeof adapter.sendToAsync === 'function') {
    return adapter.sendToAsync(instance, command, payload).then(() => true).catch(() => false);
  }
  if (typeof adapter.sendTo !== 'function') return Promise.resolve(false);
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; resolve(ok); } };
    try {
      adapter.sendTo(instance, command, payload, () => finish(true));
      setTimeout(() => finish(true), 1200);
    } catch {
      finish(false);
    }
  });
}

function pad(v) { return String(v).padStart(2, '0'); }

function templateVars(low, value, stateId) {
  const d = new Date();
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return {
    value: String(value ?? ''),
    stateId: String(stateId || ''),
    date,
    time,
    datetime: `${date} ${time}`,
    status: low ? 'zu niedrig' : 'OK'
  };
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/\{(value|stateId|date|time|datetime|status)\}/g, (_m, key) => vars[key] ?? '');
}

function install(adapter) {
  if (!adapter || adapter.__waterLevelAlert556Installed) return adapter;
  adapter.__waterLevelAlert556Installed = true;

  let lastLow = null;
  let lastAlertTs = 0;
  let subscribedId = '';
  let timer = null;

  async function ensureStates() {
    await adapter.setObjectNotExistsAsync(LOW_STATE_ID, {
      type:'state', common:{name:'Pool Wasserstand zu niedrig',type:'boolean',role:'indicator.alarm',read:true,write:false,def:false}, native:{}
    });
    await adapter.setObjectNotExistsAsync(VALUE_STATE_ID, {
      type:'state', common:{name:'Pool Wasserstand Sensorwert',type:'number',role:'value',read:true,write:false,def:0}, native:{}
    });
    await adapter.setObjectNotExistsAsync(LAST_ALERT_ID, {
      type:'state', common:{name:'Letzte Wasserstandsmeldung',type:'string',role:'text',read:true,write:false,def:''}, native:{}
    });
    await adapter.setObjectNotExistsAsync(DEBUG_ID, {
      type:'state', common:{name:'Wasserstandsalarm Diagnose 0.5.56',type:'string',role:'text',read:true,write:false,def:''}, native:{}
    });
  }

  function sensorId() {
    return String((adapter.config && adapter.config.waterLevelSensorStateId) || DEFAULT_SENSOR).trim();
  }

  function alarmEnabled() {
    return !!(adapter.config && adapter.config.enableAlerts !== false && adapter.config.alertOnLowWaterLevel === true);
  }

  function repeatMs() {
    const min = num(adapter.config && adapter.config.alertRepeatLockMin);
    return Math.max(1, min === null ? 30 : min) * 60 * 1000;
  }

  function messageFor(low, value) {
    const cfg = adapter.config || {};
    const tpl = low
      ? String(cfg.alertLowWaterLevelText || DEFAULT_LOW_TEXT)
      : String(cfg.alertWaterLevelOkText || DEFAULT_OK_TEXT);
    return renderTemplate(tpl, templateVars(low, value, sensorId()));
  }

  async function sendThroughConfiguredChannels(text, isRecovery) {
    const cfg = adapter.config || {};
    if (!cfg.enableAlerts) return false;
    let sent = false;

    if (cfg.alertWhatsappEnabled && cfg.alertWhatsappInstance) {
      const to = String(cfg.alertWhatsappTo || '').trim();
      const payload = { phone: to, to, recipient: to, message: text, text };
      sent = (await waitSendTo(adapter, String(cfg.alertWhatsappInstance), 'send', payload)) || sent;
    }

    if (cfg.alertTelegramEnabled && cfg.alertTelegramInstance) {
      const to = String(cfg.alertTelegramTo || '').trim();
      const payload = { text, user: to, chatId: to, to };
      sent = (await waitSendTo(adapter, String(cfg.alertTelegramInstance), 'send', payload)) || sent;
    }

    if (cfg.alertEmailEnabled && cfg.alertEmailInstance) {
      const to = String(cfg.alertEmailTo || '').trim();
      const payload = {
        to,
        subject: isRecovery ? 'Poolsteuerung: Wasserstand wieder OK' : 'Poolsteuerung: Wasserstand zu niedrig',
        text
      };
      sent = (await waitSendTo(adapter, String(cfg.alertEmailInstance), 'send', payload)) || sent;
    }

    return sent;
  }

  async function emitAlert(low, value, reason) {
    const text = messageFor(low, value);
    const sent = await sendThroughConfiguredChannels(text, !low);
    const stamp = new Date().toLocaleString('de-DE');
    await adapter.setStateIfChanged(LAST_ALERT_ID, `${stamp} · ${low ? 'ALARM' : 'OK'} · ${text}`, true).catch(() => {});
    await adapter.setStateIfChanged(DEBUG_ID, `${reason} · ${low ? 'NIEDRIG' : 'OK'} · Wert ${value} · Versand ${sent ? 'ja' : 'nein'}`, true).catch(() => {});

    if (adapter.log) {
      const line = `[WASSERSTAND 0.5.56] ${text}`;
      if (low) adapter.log.warn(line); else adapter.log.info(line);
    }
    return sent;
  }

  async function evaluate(value, reason) {
    const n = num(value);
    if (n === null) {
      await adapter.setStateIfChanged(DEBUG_ID, `${reason} · ungueltiger Sensorwert: ${value}`, true).catch(() => {});
      return;
    }

    const low = n === 0;
    await adapter.setStateIfChanged(VALUE_STATE_ID, n, true).catch(() => {});
    await adapter.setStateIfChanged(LOW_STATE_ID, low, true).catch(() => {});

    if (!alarmEnabled()) {
      lastLow = low;
      await adapter.setStateIfChanged(DEBUG_ID, `${reason} · ${low ? 'NIEDRIG' : 'OK'} · Alarm deaktiviert`, true).catch(() => {});
      return;
    }

    const now = Date.now();
    if (lastLow === null) {
      lastLow = low;
      if (low) {
        lastAlertTs = now;
        await emitAlert(true, n, `${reason} Erstpruefung`);
      }
      return;
    }

    if (low !== lastLow) {
      lastLow = low;
      lastAlertTs = now;
      await emitAlert(low, n, `${reason} Zustandswechsel`);
      return;
    }

    if (low && now - lastAlertTs >= repeatMs()) {
      lastAlertTs = now;
      await emitAlert(true, n, `${reason} Wiederholung`);
    }
  }

  async function poll(reason='Poll') {
    const id = sensorId();
    if (!id) return;
    try {
      const st = await adapter.getForeignStateAsync(id);
      await evaluate(st && st.val, reason);
    } catch (e) {
      await adapter.setStateIfChanged(DEBUG_ID, `${reason} · Sensor nicht lesbar: ${e.message || e}`, true).catch(() => {});
    }
  }

  function subscribe() {
    const id = sensorId();
    if (!id || id === subscribedId) return;
    try {
      if (subscribedId && typeof adapter.unsubscribeForeignStates === 'function') adapter.unsubscribeForeignStates(subscribedId);
    } catch {}
    subscribedId = id;
    try { adapter.subscribeForeignStates(id); } catch {}
  }

  adapter.on('stateChange', (id, state) => {
    if (!state || adapter.isShuttingDown) return;
    if (String(id) !== sensorId()) return;
    evaluate(state.val, 'StateChange').catch(e => {
      if (adapter.log) adapter.log.error(`[WASSERSTAND 0.5.56] Auswertung fehlgeschlagen: ${e.message || e}`);
    });
  });

  adapter.on('ready', () => {
    ensureStates().then(async () => {
      subscribe();
      await poll('Start');
      timer = setInterval(() => {
        if (!adapter.isShuttingDown) poll('Intervall').catch(() => {});
      }, 60 * 1000);
      if (typeof adapter.trackInterval === 'function') adapter.trackInterval(timer);
    }).catch(e => {
      if (adapter.log) adapter.log.error(`[WASSERSTAND 0.5.56] Initialisierung fehlgeschlagen: ${e.message || e}`);
    });
  });

  ensureStates().catch(() => {});
  return adapter;
}

function createAdapter(options={}) { return install(createBase(options)); }
if (require.main !== module) module.exports=createAdapter;
else createAdapter();

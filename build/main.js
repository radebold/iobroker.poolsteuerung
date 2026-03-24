'use strict';
const utils = require('@iobroker/adapter-core');

function parseNum(v) {
  if (v === undefined || v === null || v === '') return 0;
  return Number(String(v).replace(',', '.'));
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class Poolsteuerung extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'poolsteuerung' });
    this.timer = null;
    this.monitoredIds = [];
    this.renderQueued = false;
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  debug(msg) {
    if (this.config.debugMode) this.log.info('[DEBUG] ' + msg);
  }

  async ensureState(id, type, role, def, write = false) {
    await this.setObjectNotExistsAsync(id, {
      type: 'state',
      common: { name: id, type, role, read: true, write, def },
      native: {}
    });
    if (!write && def !== undefined) {
      await this.setStateAsync(id, def, true);
    }
  }

  calcVolume() {
    const d = parseNum(this.config.poolDiameterM);
    const h = parseNum(this.config.poolWaterHeightM);
    if (!d || !h) return 0;
    return Number((Math.PI * Math.pow(d / 2, 2) * h).toFixed(2));
  }

  async getNumber(id, digits = null) {
    if (!id) return null;
    try {
      const s = await this.getForeignStateAsync(id);
      const n = Number(String(s && s.val).replace(',', '.'));
      if (!Number.isFinite(n)) return null;
      return digits === null ? n : Number(n.toFixed(digits));
    } catch {
      return null;
    }
  }

  async getBool(id) {
    if (!id) return false;
    try {
      const s = await this.getForeignStateAsync(id);
      return !!(s && s.val);
    } catch {
      return false;
    }
  }

  async getText(id, fallback = '--') {
    if (!id) return fallback;
    try {
      const s = await this.getForeignStateAsync(id);
      return s && s.val !== undefined && s.val !== null && s.val !== '' ? String(s.val) : fallback;
    } catch {
      return fallback;
    }
  }

  fmt(n, digits = 1, fallback = '--') {
    return n === null || n === undefined || !Number.isFinite(n) ? fallback : n.toFixed(digits);
  }

  statusItemHtml(name, hint, state, compact = false) {
    if (compact) {
      return `
        <div class="statusItem">
          <div>${esc(name)}</div>
          <div class="pill ${state ? 'on' : 'off'}">${state ? 'EIN' : 'AUS'}</div>
        </div>
      `;
    }
    return `
      <div class="statusItem">
        <div>
          <div class="statusName">${esc(name)}</div>
          <div class="statusHint">${esc(hint)}</div>
        </div>
        <div class="pill ${state ? 'on' : 'off'}">${state ? 'EIN' : 'AUS'}</div>
      </div>
    `;
  }

  buildTabletHtml(data) {
    const status = [
      this.statusItemHtml('Umwälzpumpe', 'Grundlauf / Zeitfenster', data.pumpOn, false),
      this.statusItemHtml('Chlorinator', 'ORP-Regelung', data.chlorOn, false),
      this.statusItemHtml('pH-Dosierpumpe', 'Automatik / manuell', data.phPumpOn, false),
      this.statusItemHtml('Wärmepumpe', 'Solar / Batterie', data.heatpumpOn, false),
    ].join('');

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root{--bg:#0f172a;--card:#111827;--card2:#1f2937;--line:#334155;--text:#f8fafc;--muted:#94a3b8;--ok:#22c55e;--off:#ef4444}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0b1220,#111827);font-family:Arial,Helvetica,sans-serif;color:var(--text)}
.wrap{width:100%;height:100%;padding:20px}.grid{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:16px}
.card{background:linear-gradient(180deg,rgba(17,24,39,.95),rgba(31,41,55,.95));border:1px solid var(--line);border-radius:22px;padding:18px}
.title{font-size:30px;font-weight:700}.sub{font-size:13px;color:var(--muted);margin-top:6px}
.tempMain{font-size:82px;font-weight:700;line-height:1;margin:18px 0 8px}.unit{font-size:28px;color:var(--muted)}
.row{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(148,163,184,.12);padding:12px 0;font-size:20px}.row:last-child{border-bottom:none}
.label{color:var(--muted)}.value{font-weight:700}.miniGrid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:14px}
.mini{background:rgba(15,23,42,.5);border:1px solid var(--line);border-radius:16px;padding:14px}.mini .k{font-size:14px;color:var(--muted);margin-bottom:6px}.mini .v{font-size:34px;font-weight:700}
.status{display:grid;gap:12px}.statusItem{display:flex;justify-content:space-between;align-items:center;background:rgba(15,23,42,.5);border:1px solid var(--line);border-radius:16px;padding:14px}
.statusName{font-size:20px;font-weight:700}.statusHint{font-size:13px;color:var(--muted);margin-top:3px}.pill{min-width:96px;text-align:center;padding:10px 12px;border-radius:999px;font-size:15px;font-weight:700;color:#fff}.on{background:var(--ok)}.off{background:var(--off)}
</style></head><body><div class="wrap"><div class="grid">
<div class="card">
  <div class="title">Poolsteuerung</div>
  <div class="sub">Aktualisiert: ${esc(data.updated)}</div>
  <div class="tempMain">${esc(data.poolTemp)} <span class="unit">°C</span></div>
  <div class="miniGrid">
    <div class="mini"><div class="k">pH</div><div class="v">${esc(data.ph)}</div></div>
    <div class="mini"><div class="k">ORP</div><div class="v">${esc(data.orp)}</div></div>
    <div class="mini"><div class="k">Außen</div><div class="v">${esc(data.outsideTemp)}°C</div></div>
    <div class="mini"><div class="k">Solltemp</div><div class="v">${esc(data.targetTemp)}°C</div></div>
  </div>
</div>
<div class="card">
  <div class="title" style="font-size:24px">Solar / Energie</div>
  <div class="row"><div class="label">PV-Leistung</div><div class="value">${esc(data.pv)} W</div></div>
  <div class="row"><div class="label">Netzeinspeisung</div><div class="value">${esc(data.feedIn)} W</div></div>
  <div class="row"><div class="label">Netzbezug</div><div class="value">${esc(data.gridSupply)} W</div></div>
  <div class="row"><div class="label">Batterie SoC</div><div class="value">${esc(data.battery)} %</div></div>
  <div class="row"><div class="label">Heizfreigabe</div><div class="value">${esc(data.heatReason)}</div></div>
  <div class="row"><div class="label">Poolvolumen</div><div class="value">${esc(data.volume)} m³</div></div>
</div>
<div class="card">
  <div class="title" style="font-size:24px">Aktoren</div>
  <div class="status">${status}</div>
</div>
</div></div></body></html>`;
  }

  buildPhoneHtml(data) {
    const status = [
      this.statusItemHtml('Umwälzpumpe', '', data.pumpOn, true),
      this.statusItemHtml('Chlorinator', '', data.chlorOn, true),
      this.statusItemHtml('pH-Dosierpumpe', '', data.phPumpOn, true),
      this.statusItemHtml('Wärmepumpe', '', data.heatpumpOn, true),
    ].join('');

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<style>
:root{--bg:#0f172a;--card:#111827;--line:#334155;--text:#f8fafc;--muted:#94a3b8;--ok:#22c55e;--off:#ef4444}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0b1220,#111827);font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:var(--text)}
.wrap{padding:14px;max-width:390px;margin:0 auto}.card{background:rgba(17,24,39,.96);border:1px solid var(--line);border-radius:20px;padding:14px;margin-bottom:12px}
.h1{font-size:24px;font-weight:700}.sub{font-size:12px;color:var(--muted);margin-top:4px}.temp{font-size:56px;font-weight:700;line-height:1;margin:14px 0}
.grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.box{background:rgba(15,23,42,.5);border:1px solid var(--line);border-radius:14px;padding:10px}
.k{font-size:12px;color:var(--muted);margin-bottom:4px}.v{font-size:26px;font-weight:700}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.12)}.row:last-child{border-bottom:none}
.statusItem{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(148,163,184,.12)}.statusItem:last-child{border-bottom:none}
.pill{min-width:74px;text-align:center;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:700;color:#fff}.on{background:var(--ok)}.off{background:var(--off)}
</style></head><body><div class="wrap">
<div class="card">
  <div class="h1">Poolsteuerung</div>
  <div class="sub">Aktualisiert: ${esc(data.updated)}</div>
  <div class="temp">${esc(data.poolTemp)}°C</div>
  <div class="grid2">
    <div class="box"><div class="k">pH</div><div class="v">${esc(data.ph)}</div></div>
    <div class="box"><div class="k">ORP</div><div class="v">${esc(data.orp)}</div></div>
    <div class="box"><div class="k">Außen</div><div class="v">${esc(data.outsideTemp)}°C</div></div>
    <div class="box"><div class="k">Soll</div><div class="v">${esc(data.targetTemp)}°C</div></div>
  </div>
</div>
<div class="card">
  <div class="h1" style="font-size:20px">Energie</div>
  <div class="row"><div>PV</div><div><b>${esc(data.pv)} W</b></div></div>
  <div class="row"><div>Einspeisung</div><div><b>${esc(data.feedIn)} W</b></div></div>
  <div class="row"><div>Netzbezug</div><div><b>${esc(data.gridSupply)} W</b></div></div>
  <div class="row"><div>Batterie</div><div><b>${esc(data.battery)} %</b></div></div>
  <div class="row"><div>Freigabe</div><div><b>${esc(data.heatReason)}</b></div></div>
</div>
<div class="card">
  <div class="h1" style="font-size:20px">Aktoren</div>
  ${status}
</div>
</div></body></html>`;
  }

  async updateComputedStates() {
    const volume = this.calcVolume();
    await this.ensureState('info.poolVolume', 'number', 'value.volume', 0, false);
    await this.setStateAsync('info.poolVolume', volume, true);
  }


  buildTabletWidget(data) {
    const item = (name, hint, on) => `
      <div class="ps-status">
        <div>
          <div class="ps-status-name">${esc(name)}</div>
          <div class="ps-status-hint">${esc(hint)}</div>
        </div>
        <div class="ps-pill ${on ? 'on' : 'off'}">${on ? 'EIN' : 'AUS'}</div>
      </div>`;

    return `
<!-- widget-render:${esc(data.updated)} -->
<style>
.ps-root,*{box-sizing:border-box}
.ps-root{width:100%;height:100%;padding:10px;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;background:linear-gradient(180deg,#091321 0%,#08111c 100%)}
.ps-grid{display:grid;grid-template-columns:1.18fr .9fr .95fr;gap:12px;height:100%}
.ps-card{display:flex;flex-direction:column;min-width:0;background:linear-gradient(180deg,rgba(15,27,45,.98),rgba(19,36,58,.98));border:1px solid rgba(255,255,255,.08);border-radius:22px;padding:16px}
.ps-header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.ps-title{font-size:18px;font-weight:700}.ps-sub{font-size:11px;color:#9fb0c7;text-align:right}
.ps-tempRow{display:flex;align-items:flex-end;gap:8px;margin:12px 0 12px}
.ps-temp{font-size:80px;font-weight:800;line-height:.9}.ps-unit{font-size:22px;color:#9fb0c7;padding-bottom:10px}
.ps-metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:auto}
.ps-metric{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:12px;min-height:82px}
.ps-k{font-size:12px;color:#9fb0c7;margin-bottom:8px}.ps-v{font-size:20px;font-weight:700;line-height:1.15}.ps-s{font-size:11px;color:#9fb0c7;margin-top:8px}
.ps-list{display:grid;gap:8px;margin-top:10px}
.ps-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:10px 12px;min-height:50px}
.ps-row .ps-v{font-size:16px;white-space:nowrap}
.ps-statuswrap{display:grid;gap:10px;margin-top:10px}
.ps-status{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:10px 12px;min-height:70px}
.ps-status-name{font-size:15px;font-weight:700}.ps-status-hint{font-size:11px;color:#9fb0c7;margin-top:3px}
.ps-pill{min-width:78px;text-align:center;padding:8px 10px;border-radius:999px;font-size:12px;font-weight:800;color:#fff}
.ps-pill.on{background:linear-gradient(180deg,#34d399,#22c55e)}.ps-pill.off{background:linear-gradient(180deg,#f87171,#ef4444)}
</style>
<div class="ps-root">
  <div class="ps-grid">
    <div class="ps-card">
      <div class="ps-header"><div class="ps-title">Poolsteuerung</div><div class="ps-sub">Aktualisiert: ${esc(data.updated)}</div></div>
      <div class="ps-tempRow"><div class="ps-temp">${esc(data.poolTemp)}</div><div class="ps-unit">°C</div></div>
      <div class="ps-metrics">
        <div class="ps-metric"><div class="ps-k">pH</div><div class="ps-v">${esc(data.ph)}</div><div class="ps-s">Soll ${esc(data.phSet)}</div></div>
        <div class="ps-metric"><div class="ps-k">ORP</div><div class="ps-v">${esc(data.orp)}</div><div class="ps-s">Soll ${esc(data.orpSet)}</div></div>
        <div class="ps-metric"><div class="ps-k">Außen</div><div class="ps-v">${esc(data.outsideTemp)}°C</div><div class="ps-s">&nbsp;</div></div>
        <div class="ps-metric"><div class="ps-k">Solltemp</div><div class="ps-v">${esc(data.targetTemp)}°C</div><div class="ps-s">Heizen bis Soll</div></div>
      </div>
    </div>
    <div class="ps-card">
      <div class="ps-title">Solar / Energie</div>
      <div class="ps-list">
        <div class="ps-row"><div class="ps-k">PV-Leistung</div><div class="ps-v">${esc(data.pv)} W</div></div>
        <div class="ps-row"><div class="ps-k">Netzeinspeisung</div><div class="ps-v">${esc(data.feedIn)} W</div></div>
        <div class="ps-row"><div class="ps-k">Netzbezug</div><div class="ps-v">${esc(data.gridSupply)} W</div></div>
        <div class="ps-row"><div class="ps-k">Batterie SoC</div><div class="ps-v">${esc(data.battery)} %</div></div>
        <div class="ps-row"><div class="ps-k">Heizfreigabe</div><div class="ps-v">${esc(data.heatReason)}</div></div>
        <div class="ps-row"><div class="ps-k">Poolvolumen</div><div class="ps-v">${esc(data.volume)} m³</div></div>
      </div>
    </div>
    <div class="ps-card">
      <div class="ps-title">Aktoren</div>
      <div class="ps-statuswrap">
        ${item('Umwälzpumpe','Grundlauf / Zeitfenster',data.pumpOn)}
        ${item('Chlorinator','ORP-Regelung',data.chlorOn)}
        ${item('pH-Dosierpumpe','Automatik / manuell',data.phPumpOn)}
        ${item('Wärmepumpe','Solar / Batterie',data.heatpumpOn)}
      </div>
    </div>
  </div>
</div>`;
  }

  buildPhoneWidget(data) {
    return `<!-- phone-render:${esc(data.updated)} --><div style="padding:10px;color:#fff;background:#08111c;font-family:Arial">${esc(data.poolTemp)}°C | pH ${esc(data.ph)} | ORP ${esc(data.orp)} | pH Soll ${esc(data.phSet)} | ORP Soll ${esc(data.orpSet)}</div>`;
  }

  async renderVis() {
    const ph = this.fmt(await this.getNumber(this.config.phStateId, 2), 2);
    const orp = this.fmt(await this.getNumber(this.config.orpStateId, 0), 0);
    const poolTemp = this.fmt(await this.getNumber(this.config.waterTempStateId, 1), 1);
    const outsideTemp = this.fmt(await this.getNumber(this.config.outsideTempStateId, 1), 1);
    const pv = this.fmt(await this.getNumber(this.config.pvPowerStateId, 0), 0, '0');
    const feedIn = this.fmt(await this.getNumber(this.config.gridFeedInStateId, 0), 0, '0');
    const gridSupply = this.fmt(await this.getNumber(this.config.gridSupplyStateId, 0), 0, '0');
    const battery = this.fmt(await this.getNumber(this.config.batterySocStateId, 0), 0, '0');
    const targetTemp = this.fmt(parseNum(this.config.heatpumpTargetTemp), 1, '24.0');
    const heatReason = await this.getText('poolsteuerung.0.status.heatpump.lastReason', '--');
    const volume = this.fmt(this.calcVolume(), 2, '--');

    const data = {
      updated: new Date().toLocaleString('de-DE'),
      ph, orp, poolTemp, outsideTemp, pv, feedIn, gridSupply, battery, targetTemp, heatReason, volume,
      phSet: this.fmt(parseNum(this.config.phSetpoint), 2, '--'),
      orpSet: this.fmt(parseNum(this.config.orpSetpoint), 0, '--'),
      pumpOn: await this.getBool(this.config.circulationPumpSocketStateId),
      chlorOn: await this.getBool(this.config.chlorinatorSocketStateId),
      phPumpOn: await this.getBool(this.config.phPumpSocketStateId),
      heatpumpOn: await this.getBool(this.config.heatpumpPowerStateId),
    };

    const tablet = this.buildTabletHtml(data);
    const phone = this.buildPhoneHtml(data);
    const tabletWidget = this.buildTabletWidget(data);
    const phoneWidget = this.buildPhoneWidget(data);

    await this.ensureState('vis.htmlTablet', 'string', 'html', '', false);
    await this.ensureState('vis.htmlPhone', 'string', 'html', '', false);
    await this.ensureState('vis.widgetTablet', 'string', 'html', '', false);
    await this.ensureState('vis.widgetPhone', 'string', 'html', '', false);
    await this.setStateAsync('vis.htmlTablet', tablet, true);
    await this.setStateAsync('vis.htmlPhone', phone, true);
    await this.setStateAsync('vis.widgetTablet', tabletWidget, true);
    await this.setStateAsync('vis.widgetPhone', phoneWidget, true);
    await this.ensureState('status.debug.lastVisUpdate', 'string', 'text', '', false);
    await this.setStateAsync('status.debug.lastVisUpdate', data.updated, true);
  }

  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(async () => {
      this.renderQueued = false;
      try {
        await this.updateComputedStates();
        await this.renderVis();
      } catch (e) {
        this.log.warn('VIS Render Fehler: ' + e.message);
      }
    }, 400);
  }

  async subscribeConfiguredStates() {
    const ids = [
      this.config.phStateId,
      this.config.orpStateId,
      this.config.waterTempStateId,
      this.config.outsideTempStateId,
      this.config.pvPowerStateId,
      this.config.gridFeedInStateId,
      this.config.gridSupplyStateId,
      this.config.batterySocStateId,
      this.config.phPumpSocketStateId,
      this.config.chlorinatorSocketStateId,
      this.config.circulationPumpSocketStateId,
      this.config.heatpumpPowerStateId,
      'poolsteuerung.0.status.heatpump.lastReason'
    ].filter(Boolean);

    this.monitoredIds = [...new Set(ids)];
    for (const id of this.monitoredIds) {
      try { this.subscribeForeignStates(id); } catch {}
    }
  }

  async onReady() {
    await this.ensureState('info.connection', 'boolean', 'indicator.connected', false, false);
    await this.ensureState('status.debug.lastCycle', 'string', 'text', '', false);
    await this.setStateAsync('info.connection', true, true);
    await this.subscribeConfiguredStates();
    await this.updateComputedStates();
    await this.renderVis();
    const pollMin = Math.max(1, Number(this.config.pollIntervalMin) || 1);
    this.timer = setInterval(async () => {
      await this.setStateAsync('status.debug.lastCycle', new Date().toISOString(), true);
      await this.updateComputedStates();
      await this.renderVis();
    }, pollMin * 60000);
    this.debug(`VIS-HTML aktiv: poolsteuerung.0.vis.htmlTablet / htmlPhone, Poll=${pollMin}min`);
  }

  async onStateChange(id, state) {
    if (!state) return;
    if (this.monitoredIds.includes(id)) {
      this.debug(`State geändert: ${id}`);
      this.queueRender();
    }
  }

  async onUnload(callback) {
    try {
      if (this.timer) clearInterval(this.timer);
      await this.setStateAsync('info.connection', false, true);
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = options => new Poolsteuerung(options);
} else {
  (() => new Poolsteuerung())();
}

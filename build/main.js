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

    return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=980,height=730">
<style>
:root{--bg:#09111d;--card:#0f1b2d;--card2:#14253d;--line:rgba(255,255,255,.08);--text:#f8fafc;--muted:#9fb0c7;--accent:#38bdf8;--ok:#22c55e;--off:#ef4444}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#10203a 0%,#09111d 42%,#070d18 100%);font-family:Arial,Helvetica,sans-serif;color:var(--text)}
.wrap{width:980px;height:730px;padding:16px;overflow:hidden}
.grid{display:grid;grid-template-columns:430px 250px 252px;gap:16px;height:100%}
.card{background:linear-gradient(180deg,rgba(15,27,45,.98),rgba(20,37,61,.98));border:1px solid var(--line);border-radius:24px;padding:18px;box-shadow:0 16px 34px rgba(0,0,0,.30)}
.title{font-size:20px;font-weight:700;letter-spacing:.2px}
.sub{font-size:12px;color:var(--muted);margin-top:6px}
.tempMain{font-size:96px;font-weight:800;line-height:.95;margin:20px 0 12px;letter-spacing:-2px}
.unit{font-size:28px;color:var(--muted);font-weight:600;margin-left:4px}
.metricGrid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:10px}
.metric{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:18px;padding:14px}
.metric .k{font-size:13px;color:var(--muted);margin-bottom:6px}
.metric .v{font-size:24px;font-weight:700}
.energyList{display:grid;gap:10px;margin-top:10px}
.energyRow{display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:16px;padding:12px 14px}
.energyRow .k{font-size:13px;color:var(--muted)}
.energyRow .v{font-size:20px;font-weight:700}
.statusWrap{display:grid;gap:10px;margin-top:10px}
.statusItem{display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:16px;padding:12px 14px}
.statusName{font-size:17px;font-weight:700}
.statusHint{font-size:12px;color:var(--muted);margin-top:3px}
.pill{min-width:86px;text-align:center;padding:9px 12px;border-radius:999px;font-size:13px;font-weight:800;color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.16)}
.on{background:linear-gradient(180deg,#34d399,#22c55e)}
.off{background:linear-gradient(180deg,#f87171,#ef4444)}
.headBadge{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.22);color:#7dd3fc;font-size:12px;margin-top:10px}
.glow{box-shadow:0 0 0 1px rgba(56,189,248,.06),0 10px 24px rgba(2,132,199,.08)}
</style></head><body><div class="wrap"><div class="grid">
<div class="card glow">
  <div class="title">Poolsteuerung</div>
  <div class="sub">Aktualisiert: ${esc(data.updated)}</div>
  <div class="headBadge">Live Status</div>
  <div class="tempMain">${esc(data.poolTemp)}<span class="unit">°C</span></div>
  <div class="metricGrid">
    <div class="metric"><div class="k">pH</div><div class="v">${esc(data.ph)}</div></div>
    <div class="metric"><div class="k">ORP</div><div class="v">${esc(data.orp)}</div></div>
    <div class="metric"><div class="k">Außentemperatur</div><div class="v">${esc(data.outsideTemp)}°C</div></div>
    <div class="metric"><div class="k">Solltemperatur</div><div class="v">${esc(data.targetTemp)}°C</div></div>
  </div>
</div>
<div class="card">
  <div class="title">Solar / Energie</div>
  <div class="energyList">
    <div class="energyRow"><div class="k">PV-Leistung</div><div class="v">${esc(data.pv)} W</div></div>
    <div class="energyRow"><div class="k">Netzeinspeisung</div><div class="v">${esc(data.feedIn)} W</div></div>
    <div class="energyRow"><div class="k">Netzbezug</div><div class="v">${esc(data.gridSupply)} W</div></div>
    <div class="energyRow"><div class="k">Batterie SoC</div><div class="v">${esc(data.battery)} %</div></div>
    <div class="energyRow"><div class="k">Heizfreigabe</div><div class="v">${esc(data.heatReason)}</div></div>
    <div class="energyRow"><div class="k">Poolvolumen</div><div class="v">${esc(data.volume)} m³</div></div>
  </div>
</div>
<div class="card">
  <div class="title">Aktoren</div>
  <div class="statusWrap">${status}</div>
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
      pumpOn: await this.getBool(this.config.circulationPumpSocketStateId),
      chlorOn: await this.getBool(this.config.chlorinatorSocketStateId),
      phPumpOn: await this.getBool(this.config.phPumpSocketStateId),
      heatpumpOn: await this.getBool(this.config.heatpumpPowerStateId),
    };

    const tablet = this.buildTabletHtml(data);
    const phone = this.buildPhoneHtml(data);

    await this.ensureState('vis.htmlTablet', 'string', 'html', '', false);
    await this.ensureState('vis.htmlPhone', 'string', 'html', '', false);
    await this.setStateAsync('vis.htmlTablet', tablet, true);
    await this.setStateAsync('vis.htmlPhone', phone, true);
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

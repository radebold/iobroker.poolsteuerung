'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');

// Zuerst alle 0.5.60-Patches (Objekte + Chlor-Loglevel) anwenden.
require('./patch-objects-560.js');

const ioFile=path.join(root,'io-package.json');
const io=JSON.parse(fs.readFileSync(ioFile,'utf8'));
io.version='0.5.61';
io.common=io.common||{};
io.common.version='0.5.61';
fs.writeFileSync(ioFile,JSON.stringify(io,null,2)+'\n');

const rel='build/main-ipadmini-final-067.js';
const file=path.join(root,rel);
if(!fs.existsSync(file)) throw new Error(`[0.5.61] Datei fehlt: ${rel}`);
let src=fs.readFileSync(file,'utf8');

// Hilfsfunktion direkt nach readRaw() einfuegen. Sie verwendet denselben
// konfigurierten Aktor wie die Poolregelung und akzeptiert bool/0-1/string.
const readRawBlock=`  async function readRaw() {\n    const state = await adapter.getForeignStateAsync(RAW_ID);\n    const raw = num(state && state.val);\n    const ts = Number(state && (state.ts || state.lc)) || 0;\n    return {\n      raw,\n      ageMs: ts ? Math.max(0, Date.now() - ts) : 0,\n      state\n    };\n  }\n`;
const readRawReplacement=readRawBlock+`\n  function boolStateValue(value) {\n    if (typeof value === 'boolean') return value;\n    if (typeof value === 'number') return value !== 0;\n    return ['1','true','on','ein','yes','ja','active','aktiv'].includes(String(value ?? '').trim().toLowerCase());\n  }\n\n  async function circulationPumpRunning() {\n    const id = String((adapter.config && adapter.config.circulationPumpSocketStateId) || '').trim();\n    if (!id) return false;\n    try {\n      const state = await adapter.getForeignStateAsync(id);\n      return !!state && boolStateValue(state.val);\n    } catch {\n      return false;\n    }\n  }\n`;
if(src.includes(readRawBlock) && !src.includes('async function circulationPumpRunning()')){
  src=src.replace(readRawBlock,readRawReplacement);
}

const oldCycle=`  async function cycle() {\n    if (adapter.isShuttingDown || adapter.__latestOffset067Busy) return;\n    adapter.__latestOffset067Busy = true;\n    try {\n      await processInputs();\n      await enforceStoredPoints('Neuester Kalibrierpunkt aktiviert');\n    } catch (error) {\n      const text = error && error.message ? error.message : String(error);\n      await adapter.setStateIfChanged(RESULT_ID, \`Kalibrierung fehlgeschlagen: \${text}\`, true);\n      await adapter.setStateIfChanged('status.phCalibration.lastMessage', \`Kalibrierung fehlgeschlagen: \${text}\`, true);\n      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', true, true);\n      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', \`Kalibrierung fehlgeschlagen: \${text}\`, true);\n      if (!adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {\n        adapter.log.warn(\`[PH-KAL] \${VERSION}: \${text}\`);\n      }\n    } finally {\n      adapter.__latestOffset067Busy = false;\n    }\n  }\n`;

const newCycle=`  async function cycle() {\n    if (adapter.isShuttingDown || adapter.__latestOffset067Busy) return;\n    adapter.__latestOffset067Busy = true;\n    try {\n      const pumpRunning = await circulationPumpRunning();\n\n      // PH803 misst nur sinnvoll bei laufender Umwaelzung. Ausserhalb des\n      // Pumpenfensters ist ein alter Rohwert erwartbar und darf weder Alarm\n      // noch Kalibrierfehler erzeugen.\n      if (!pumpRunning) {\n        adapter.__latestOffset067LastStaleWarnAt = 0;\n        await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', false, true);\n        await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', '', true);\n        return;\n      }\n\n      await processInputs();\n      await enforceStoredPoints('Neuester Kalibrierpunkt aktiviert');\n\n      // Ein erfolgreicher Zyklus beendet eine vorherige Stale-Alarmphase.\n      adapter.__latestOffset067LastStaleWarnAt = 0;\n      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', false, true);\n      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', '', true);\n    } catch (error) {\n      const text = error && error.message ? error.message : String(error);\n      const staleRaw = /^PH803-Rohwert ist \\d+ Minuten alt$/.test(text);\n\n      await adapter.setStateIfChanged(RESULT_ID, \`Kalibrierung fehlgeschlagen: \${text}\`, true);\n      await adapter.setStateIfChanged('status.phCalibration.lastMessage', \`Kalibrierung fehlgeschlagen: \${text}\`, true);\n      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlocked', true, true);\n      await adapter.setStateIfChanged('status.phCalibration.autoDoseBlockReason', \`Kalibrierung fehlgeschlagen: \${text}\`, true);\n\n      // Bei laufender Pumpe bleibt ein alter Rohwert sicherheitsrelevant,\n      // aber wir loggen ihn hoechstens einmal je 10 Minuten statt alle 750 ms.\n      const now = Date.now();\n      const canLog = !staleRaw || !adapter.__latestOffset067LastStaleWarnAt || (now - adapter.__latestOffset067LastStaleWarnAt) >= 10 * 60 * 1000;\n      if (canLog && !adapter.isDbClosedError(error) && adapter.log && typeof adapter.log.warn === 'function') {\n        if (staleRaw) adapter.__latestOffset067LastStaleWarnAt = now;\n        adapter.log.warn(\`[PH-KAL] \${VERSION}: \${text}\`);\n      }\n    } finally {\n      adapter.__latestOffset067Busy = false;\n    }\n  }\n`;

if(src.includes(oldCycle)){
  src=src.replace(oldCycle,newCycle);
}else if(!src.includes('const pumpRunning = await circulationPumpRunning();')){
  throw new Error('[0.5.61] cycle()-Block in 0.4.67 nicht gefunden; Patch abgebrochen');
}

fs.writeFileSync(file,src);
console.log('[0.5.61] PH803-Alterspruefung an Umwaelzpumpe gekoppelt; Stale-Warnung auf max. 1/10min begrenzt');

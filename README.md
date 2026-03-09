# ioBroker.poolpilot

Starter-Projekt für einen ioBroker-Adapter zur Steuerung eines Salzwasserpools.

## Enthaltene Funktionsblöcke

1. **pH-Minus-Dosierung** über eine Smart-Steckdose
2. **Chlorinator-Steuerung** über ORP/Redox mit Hysterese
3. **Umwälzpumpen-Zeitsteuerung**
4. **Wärmepumpen-Logik** auf Basis von Wassertemperatur, PV-Überschuss und Hausakku-Status

## Ausgangsbasis

Die Logik ist aus deinen beiden vorhandenen JavaScript-Skripten konsolidiert worden:

- `phminus.js`
- `pumpe_und_Chlorinatorsteuerung.js`

## Wichtige Zustände im Adapter

### control
- `control.manualDoseTrigger`
- `control.dosingEnabled`
- `control.orpAutoEnabled`

### status
- `status.dosingActive`
- `status.chlorinatorStateText`
- `status.heatingStateText`
- `status.nextDoseTime`
- `status.lastAction`
- `status.lastOrpSwitchIso`

### calc
- `calc.poolVolumeL`
- `calc.plannedDoseMl`
- `calc.plannedDoseSeconds`
- `calc.plannedGranulateG`
- `calc.actualDoseMl`
- `calc.lastPh`
- `calc.restSeconds`

## Noch offen / bewusst als Starter umgesetzt

- keine vollständige Admin-React-Oberfläche, sondern `jsonConfig.json`
- keine Übersetzungsdateien
- kein Test-Setup
- kein GitHub-Workflow / Release-Build
- keine komplexe Fehlerbehandlung für ungültige Fremd-States
- keine Abhängigkeit zu Solar-/Batterieadaptern, sondern freie State-IDs

## Nächste sinnvolle Ausbaustufen

1. Adaptername final festlegen, Repo anlegen und mit `@iobroker/create-adapter` sauber initialisieren
2. Diesen Logikblock in das generierte Projekt übernehmen
3. Admin-UI verfeinern
4. Zusätzliche Sicherheitslogik einbauen:
   - minimale Laufzeit der Umwälzpumpe vor Dosierung
   - Sperrzeit nach Dosierung
   - Temperatur-Minimum für Chlorinator
   - Freigabeschalter für Heizen
5. History-/Echarts-geeignete Datenpunkte ergänzen
6. VIS-/Material-Design-Oberfläche dazu bauen

## Installation als Basis

Dieses Paket ist ein **technischer Startpunkt**, noch kein veröffentlichungsreifer Adapter.

Zum Weiterbauen:

```bash
npm install
```

Danach im ioBroker-Adapterprojekt die üblichen Build-/Test-Schritte ergänzen.

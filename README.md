# ioBroker Poolsteuerung

Version: `0.3.15-hotfix24`

## VIS HTML

Der Adapter erzeugt die VIS-Ausgaben direkt als States:

- `poolsteuerung.0.vis.htmlTablet`
- `poolsteuerung.0.vis.htmlPhone`
- `poolsteuerung.0.vis.widgetTablet`
- `poolsteuerung.0.vis.widgetPhone`

## pH-Minus Kanisterverwaltung

In dieser Version ist die pH-Minus-Kanisterverwaltung direkt in die Poolsteuerung integriert.

### Neue States

Status:

- `poolsteuerung.0.status.phCanister.capacityL`
- `poolsteuerung.0.status.phCanister.usedL`
- `poolsteuerung.0.status.phCanister.restL`
- `poolsteuerung.0.status.phCanister.restPercent`
- `poolsteuerung.0.status.phCanister.warning`
- `poolsteuerung.0.status.phCanister.critical`
- `poolsteuerung.0.status.phCanister.orderRecommended`
- `poolsteuerung.0.status.phCanister.statusText`
- `poolsteuerung.0.status.phCanister.lastDoseMl`
- `poolsteuerung.0.status.phCanister.lastDoseTs`
- `poolsteuerung.0.status.phCanister.lastCorrection`
- `poolsteuerung.0.status.phCanister.lastReset`

Bedienung:

- `poolsteuerung.0.control.phCanister.measuredRestL`
- `poolsteuerung.0.control.phCanister.applyCorrection`
- `poolsteuerung.0.control.phCanister.newCanister`
- `poolsteuerung.0.control.phCanister.capacityL`

### Funktion

Beim Start einer echten pH-Dosierung wird anhand der konfigurierten Fördermenge der pH-Pumpe automatisch Verbrauch gebucht:

```text
Verbrauch ml = Dosierdauer Sekunden × Fördermenge ml/min ÷ 60
```

Im Simulationsmodus wird kein Kanisterverbrauch gebucht.

### VIS Bedienung

Die VIS-Karten enthalten jetzt direkt:

- Restinhalt in Litern
- Verbrauch in Litern
- Füllstand in Prozent
- Warnstatus OK / BESTELLEN / KRITISCH
- Eingabefeld für gemessenen Restinhalt
- Button „Neuer Kanister“
- Button „Größe“

### Konfiguration

Im Adapter-Admin unter `PH` gibt es neue Felder:

- Kanistergröße pH-Minus, Standard `10 l`
- Nachbestellen ab Rest, Standard `2 l`
- Kritisch ab Rest, Standard `1 l`

### Änderung 0.3.15-hotfix24

- Der aktuelle pH-Minus-Füllstand wird in der UI jetzt prominent als eigener Wert angezeigt: `Aktueller Füllstand x l von y l`.
- Das Korrekturfeld ist klar als aktueller Füllstand in Liter beschriftet.


## 0.3.15-hotfix27
- pH-Minus-Kanister-Karte in der Haupt-UI kompakter dargestellt.
- Außen- und Solltemperatur in der linken Spalte unter den Pool-Manager verschoben.
- Button/Eingabe für manuelle pH-Dosierung in ml ergänzt.


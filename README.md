## v0.3.54

- Fix: zentrale Netto-Gewichtsberechnung aus Waagen-Bruttogewicht minus Tara.
- VIS, Warnungen und Admin-Füllstand verwenden denselben State `status.phCanister.netWeightKg`.

## v0.3.53

- Mobile manuelle pH-Dosierung wie im Tablet: feste Buttons für 60, 120 und 180 Sekunden.
- Jeder Dosierbutton hat ein passendes Tropfen-Symbol.
- Keine Änderung an Dosier- oder Steuerlogik.

## v0.3.53

- Tablet: Pooltemperatur-Tageslinie direkt neben der Überschrift, innerhalb der Karte.
- Versionsanzeige in Adapter, VIS und Metadaten vereinheitlicht.

# ioBroker Poolsteuerung

## v0.3.50

- Tablet-VIS: Auto-Status für Pumpe, Chlor, pH und Wärmepumpe ist jetzt als klickbarer Button umgesetzt.
- Klick schaltet die jeweiligen States `control.auto.circulation`, `control.auto.chlor`, `control.auto.ph`, `control.auto.heatpump`.
- Bestehende Fixes aus hotfix68 bleiben enthalten.

# ioBroker Poolsteuerung

## v0.3.50-hotfix68
- Neues Admin-UI-Feld im pH-Tab: Standarddauer PH Manuell (Sekunden).
- Wenn leer/0, wird für manuelle pH-Dosierung auf 30 Sekunden zurückgefallen.
- Der VIS-State control.ph.manualDoseSec wird beim Start nur initial gesetzt, wenn er leer ist.


Version v0.3.50-hotfix68

## v0.3.50-hotfix68
- Tablet-VIS aufgeräumt: Poolvolumen, Pumpenleistung und ml/0,1/10m³ aus Zusatzwerten entfernt.
- ORP-Schaltgrenzen direkt am ORP-Wert angezeigt.
- pH-Korrektur zum Sollwert als ml und Sekunden eingeblendet, nur wenn pH über Soll liegt.
- pH-Zielbereich ergänzt: optimal 7,2–7,4; sehr gut/unkritisch 7,0–7,4.
- Render-Fix aus hotfix68/59 bleibt enthalten.

- Wärmepumpensteuerung vereinfacht: EIN nur bei laufender Umwälzpumpe und Einspeisung >= WP-EIN-Schwelle.
- AUS bei gestoppter Umwälzpumpe, Standby oder Einspeisung < WP-AUS-Hysterese.
- Temperaturprüfung und Anti-Pendel-Mindestzeiten aus der WP-Freigabelogik entfernt.
- VIS-Render-Fix aus hotfix68 bleibt enthalten.

## v0.3.50-hotfix68
- Tablet-VIS: doppelte Anzeige 'Letzte pH-Dosis' entfernt.
- Tablet-VIS: doppelte Zusatzwert-Anzeige 'PV Schwelle' entfernt.


## v0.3.50-hotfix68
- Manuelle pH-Dosierdauer aus der Adapter-UI wird beim Start in `control.ph.manualDoseSec` übernommen, wenn gepflegt.
- Bei leerem/0-Konfigurationswert bleibt ein vorhandener VIS-State erhalten; fallback nur dann 30 Sekunden.
- Tablet-VIS Schnellzugriff kompakter: PH-Manuell-Button und Eingabe kleiner.


## v0.3.50
- VIS auf Basis des hochgeladenen stabilen Stands erweitert.
- pH-Minus-Kanister in Tablet-/Phone-VIS ergänzt.
- Manueller pH-Dosierbutton bleibt erhalten.
- Füllstand mit 2 Nachkommastellen und Kanister-Reset.


## v0.3.50
- pH-Minus-Zusatzkachel als Ampelanzeige mit deutschem Zahlenformat ergänzt.


## 0.3.50
- Tablet-VIS auf 1130 × 740 px erweitert.
- Vorhandene Adapter-Schaltflächen nutzen den zusätzlichen Platz; keine Steuerlogik geändert.


## 0.3.50
- Tablet-Schnellzugriff: Poolsolltemperatur-Kachel entfernt.
- Manuelle pH-Dosierung als drei feste, touchfreundliche Buttons: 60, 120 und 180 Sekunden.
- Pooltemperatur-Sparkline bleibt rechts neben Temperaturwert und Einheit.


## 0.3.53
- pH-Tagesstatistik verwendet den lokalen Kalendertag statt UTC.
- VIS prüft den Tageswechsel vor der Anzeige.
- Einmaliger Reset veralteter/falscher Tageszähler bei der ersten Installation dieser Version.


## 0.3.55
- Fix: Waagenwerte werden nicht mehr auf ganze Kilogramm gerundet, bevor die Tara abgezogen wird.

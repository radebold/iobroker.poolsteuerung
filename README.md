# ioBroker Poolsteuerung

## 0.3.16-hotfix68
- Neues Admin-UI-Feld im pH-Tab: Standarddauer PH Manuell (Sekunden).
- Wenn leer/0, wird für manuelle pH-Dosierung auf 30 Sekunden zurückgefallen.
- Der VIS-State control.ph.manualDoseSec wird beim Start nur initial gesetzt, wenn er leer ist.


Version 0.3.16-hotfix68

## 0.3.16-hotfix68
- Tablet-VIS aufgeräumt: Poolvolumen, Pumpenleistung und ml/0,1/10m³ aus Zusatzwerten entfernt.
- ORP-Schaltgrenzen direkt am ORP-Wert angezeigt.
- pH-Korrektur zum Sollwert als ml und Sekunden eingeblendet, nur wenn pH über Soll liegt.
- pH-Zielbereich ergänzt: optimal 7,2–7,4; sehr gut/unkritisch 7,0–7,4.
- Render-Fix aus hotfix68/59 bleibt enthalten.

- Wärmepumpensteuerung vereinfacht: EIN nur bei laufender Umwälzpumpe und Einspeisung >= WP-EIN-Schwelle.
- AUS bei gestoppter Umwälzpumpe, Standby oder Einspeisung < WP-AUS-Hysterese.
- Temperaturprüfung und Anti-Pendel-Mindestzeiten aus der WP-Freigabelogik entfernt.
- VIS-Render-Fix aus hotfix68 bleibt enthalten.

## 0.3.16-hotfix68
- Tablet-VIS: doppelte Anzeige 'Letzte pH-Dosis' entfernt.
- Tablet-VIS: doppelte Zusatzwert-Anzeige 'PV Schwelle' entfernt.


## 0.3.16-hotfix68
- Manuelle pH-Dosierdauer aus der Adapter-UI wird beim Start in `control.ph.manualDoseSec` übernommen, wenn gepflegt.
- Bei leerem/0-Konfigurationswert bleibt ein vorhandener VIS-State erhalten; fallback nur dann 30 Sekunden.
- Tablet-VIS Schnellzugriff kompakter: PH-Manuell-Button und Eingabe kleiner.

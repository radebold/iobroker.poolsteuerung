# ioBroker Poolsteuerung 0.3.16-hotfix57

Diagnose-Version für VIS-Rendering.

Wichtig: Im ioBroker-Log muss beim Start exakt `Version 0.3.16-hotfix57` und `[VIS] hotfix57 Diagnose-Logging aktiv` stehen. Wenn dort noch hotfix54 steht, wurde nicht diese ZIP installiert oder die alte Adapterdatei wird weiter ausgeführt.

Änderungen:
- VIS-Rendering beim Adapterstart erzwungen
- leere VIS-States werden erkannt und neu befüllt
- `[VIS]` Logpunkte vor und nach dem Rendern
- Fallback-HTML mit Fehlerausgabe, falls der Vollrender abbricht

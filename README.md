# ioBroker Poolsteuerung

Version 0.3.16-hotfix58

Fix: VIS-Rendering beim Start wird erzwungen. History-Trends haben Timeout, damit das Rendern nicht hängen bleibt. Zusätzlich Render-Lock gegen parallele Renderläufe.


## 0.3.16-hotfix59
- Wärmepumpensteuerung vereinfacht: EIN nur bei laufender Umwälzpumpe und Einspeisung >= WP-EIN-Schwelle.
- AUS bei gestoppter Umwälzpumpe, Standby oder Einspeisung < WP-AUS-Hysterese.
- Temperaturprüfung und Anti-Pendel-Mindestzeiten aus der WP-Freigabelogik entfernt.
- VIS-Render-Fix aus hotfix58 bleibt enthalten.

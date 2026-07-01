# SplitMoney

SplitMoney ist eine kleine Selfhost-App für gemeinsame Ausgaben. Es gibt keinen Login, keine Admins und keine Rollen. Eine Runde wird über einen zufälligen Link geöffnet; wer den Link hat, kann alles sehen und bearbeiten.

## Funktionen

- Eindeutiger Gruppenlink pro Runde
- Personen mit gezahltem Betrag hinzufügen
- Namen und gezahlte Beträge bearbeiten
- Personen entfernen
- Gesamtsumme, Personenbilanz und minimale Überweisungen berechnen
- Live-Hinweis, bis alle Beträge eingetragen sind
- SQLite-Datenbank im Docker-Volume
- Links laufen standardmäßig nach 4 Wochen ab
- Verlängerung um eine Woche innerhalb der letzten 7 Tage
- Keine externen Dienste und kein Build-Schritt

## Start mit Docker Compose

```bash
docker compose up -d
```

Danach `http://localhost:8080` öffnen. Beim ersten Aufruf wird automatisch eine neue Runde erstellt und die URL auf `/g/<gruppen-id>` gesetzt. Diesen Link kannst du an alle Beteiligten schicken.

Die SQLite-Datenbank liegt im Volume `splitmoney-data` unter `/data/splitmoney.sqlite3`.

## Fertiges Docker-Image

GitHub Actions baut automatisch ein Docker-Image und veröffentlicht es in der GitHub Container Registry:

```bash
docker run -d \
  --name splitmoney \
  -p 8080:8080 \
  -v splitmoney-data:/data \
  ghcr.io/daranto/splitmoney:latest
```

## Start ohne Docker

```bash
SPLITMONEY_DATA_DIR=./data python3 server.py
```

Danach `http://localhost:8080` öffnen.

## Konfiguration

- `PORT`: HTTP-Port im Container, Standard `8080`
- `SPLITMONEY_DATA_DIR`: Ordner für die SQLite-Datei, Standard `/data`
- `SPLITMONEY_DB`: kompletter Pfad zur SQLite-Datei, überschreibt `SPLITMONEY_DATA_DIR`

## Backup

Bei Docker Compose reicht ein Backup des Docker-Volumes oder der Datei:

```bash
docker compose exec splitmoney cp /data/splitmoney.sqlite3 /data/splitmoney-backup.sqlite3
```

## Sicherheit

Der Gruppenlink ist der Zugriffsschlüssel. Wer den Link kennt, kann die Runde bearbeiten. Für den Betrieb im Internet solltest du die App hinter HTTPS betreiben, zum Beispiel hinter Caddy, Traefik oder nginx.

## Ablaufdatum

Neue Runden laufen nach 4 Wochen ab. Das Ablaufdatum steht oben in der App. Innerhalb der letzten 7 Tage kann jede Person mit dem Link die Runde über den Button `Eine Woche verlängern` um weitere 7 Tage verlängern. Nach Ablauf liefert der Server `410 Gone`; der Link ist dann ungültig.

## Berechnung

Alle eingetragenen Beträge werden addiert und gleichmäßig auf alle Personen verteilt. Wenn die Gesamtsumme nicht glatt teilbar ist, werden die Rest-Cents in der Reihenfolge der Personen vergeben. Danach werden positive und negative Bilanzen gegeneinander verrechnet, sodass möglichst wenige Überweisungen entstehen.

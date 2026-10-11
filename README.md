# FlyMaps

An interactive immersive 3D map / geographic exploration application with flight-style navigation.

* Erkundung von Gebieten
* geografische Visualisierung
* Navigation und räumliches Verständnis

Vite + CesiumJS-Setup, das Googles Photorealistic 3D Tiles lädt und eine
Flugsteuerung mit HUD, Minimap, Ortssuche und 3D-Spots bereitstellt.

## Setup

1. Abhängigkeiten installieren:
   ```bash
   npm install
   ```

2. Google Maps Platform API-Keys besorgen (siehe `.env.example` für Details
   zu den empfohlenen Restrictions je Key):
   - Billing-Konto hinterlegen (auch im kostenlosen Kontingent nötig)
   - Projekt in der [Google Cloud Console](https://console.cloud.google.com/)
     anlegen
   - **Map Tiles API** aktivieren -> Key für `VITE_GOOGLE_MAPS_API_KEY`
   - **Geocoding API** aktivieren -> eigener Key für `GEOCODING_API_KEY`
     (Ortssuche/3D-Spots-Klick), läuft server-seitig über
     `functions/api/geocode.js`

3. Keys eintragen:
   - `.env`: `VITE_GOOGLE_MAPS_API_KEY=...`
   - `.dev.vars`: `GEOCODING_API_KEY=...` (nur für lokale Cloudflare Pages
     Function, siehe unten)

4. Dev-Server starten:
     ```bash
     npm run dev
     ```

  Browser öffnen unter `http://127.0.0.1:5173`. Die Ortssuche nutzt lokal
  automatisch den Geocoding-Key aus `.dev.vars`.

  Um die Cloudflare-Pages-Functions gezielt lokal zu testen:
     ```bash
     npm run pages:dev
     ```
     Browser öffnen unter `http://127.0.0.1:8788`.

     `.dev.vars` wird nur beim Start von `wrangler pages dev` eingelesen -
     nach Änderungen am Key den Server neu starten.

## Features

- CesiumJS-Viewer, UI-Chrome (Toolbar, Timeline etc.) ausgeblendet
- Googles Photorealistic 3D Tiles via `Cesium.createGooglePhotorealistic3DTileset()`
- Tastatur-Steuerung
- HUD mit Status/Höhe/Geschwindigkeit, Minimap (OSM-Kacheln), Horizont-Anzeige
- Ortssuche über die Google Geocoding API (server-seitig über
  `functions/api/geocode.js`, Key landet nie im Client-Bundle)
- 3D-Spots-Liste (bekannte Photorealistic-3D-Tiles-Coverage-Gebiete,
  siehe `src/google_earth_3d_locations_by_country.json`)
- Favoriten werden lokal gespeichert. Bei `npm run dev` und `npm run preview`
  nutzt die Vite-Middleware `%LOCALAPPDATA%\FlyMaps\favorites.json`; im
  Cloudflare-/Browser-only-Betrieb fällt die App auf `localStorage` zurück.
- Kollisionserkennung mit Gebäuden/Terrain (3D Tiles)

## Geplant

* [ ] Stick Overlay
* [ ] Tastenbelegung ändern
  * [ ] Tastatur
  * [ ] Controller
* [ ] Seployment, aurfuen über Server
* [ ] Eingabe eines eigenen API-Keys
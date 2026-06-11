# Würzburg 3D 🏰

Eine interaktive, frei begehbare 3D-Karte von Würzburg im Browser — gebaut aus **echten Geodaten**:

- **Gebäude, Straßen, Brücken, Main, Parks & Weinberge** live von [OpenStreetMap](https://www.openstreetmap.org) (Overpass API), mit echten Gebäudehöhen wo vorhanden
- **Echtes Geländemodell** (Mapzen/AWS Terrain Tiles) — die Festung Marienberg thront wirklich ~85 m über dem Maintal
- **Stimmungsvolles Rendering**: Tageszeit-Regler (Tag → Dämmerung → Nacht), prozedural beleuchtete Fenster, Straßenlaternen, fließender Verkehr, animiertes Wasser mit Sonnen-/Mondglitzern, Bloom, Nebel, Sternenhimmel
- **Freie Kamera**: Orbit-Modus (Drehen/Zoomen/Verschieben) und Flugmodus (WASD + Maus), filmische Kamerafahrten zu 11 Sehenswürdigkeiten

## Schnellstart

```bash
npm install
npm run dev        # → http://localhost:5173
```

Beim ersten Start lädt die App die Stadtdaten (~10–30 MB) von der Overpass API und cached sie
danach in IndexedDB — weitere Starts sind sofort da. Es werden keine API-Keys benötigt.

```bash
npm run build      # Produktions-Build nach dist/
npm run preview    # Build lokal testen
```

## Steuerung

| Aktion | Orbit-Modus | Flugmodus (Taste `F`) |
| --- | --- | --- |
| Umsehen | Linke Maus ziehen | Maus (Pointer Lock) |
| Bewegen | Rechte Maus ziehen | `W A S D` |
| Hoch / Runter | — | `E` / `Q` (oder Space / `C`) |
| Zoom / Tempo | Scrollen | Scrollen |
| Boost | — | `Shift` |

Klick auf ein Label oder einen Eintrag in der Seitenleiste fliegt die Kamera zur Sehenswürdigkeit.
Der Regler oben rechts blendet zwischen Nachmittag, Dämmerung und Nacht.

## Architektur

```
tools/bake-terrain.mjs   Heightmap-Baker (AWS Terrain Tiles → public/data/terrain.bin)
tools/screenshot.mjs     Headless-Screenshot-Harness (Puppeteer, synthetische Stadt)
src/
  config.js     Kartenausschnitt, Landmarken, Overpass-Endpoints
  geo.js        Lokale Meter-Projektion
  terrain.js    Heightmap-Sampling + Geländemesh
  osm.js        Overpass-Fetch (Fallback-Server, IndexedDB-Cache) + Parsing
  buildings.js  Extrudierte Gebäude, Fenster-Shader, Landmark-Floodlight
  roads.js      Straßenbänder aufs Gelände drapiert, Brücken mit Seitenwänden
  water.js      Main: Wasserspiegel, Flussbett-Absenkung, Wellen-Shader
  greenery.js   Grünflächen + instanzierte Bäume
  lights.js     Straßenlaternen + animierte Autolichter
  sky.js        Himmel, Sonne/Mond, Nebel, Tageszeit-Keyframes
  cameraRig.js  Orbit + Flugmodus + filmische Flüge
  main.js       Bootstrapping, Postprocessing (Bloom), HUD
test/smoke.mjs  Headless-Tests (Gelände-Plausibilität, Geometrie)
```

### Daten neu backen

```bash
npm run bake-terrain   # lädt die Terrarium-Tiles neu und schreibt public/data/
```

### Amtliche LoD2-Gebäudemodelle (optional, empfohlen!)

Die Bayerische Vermessungsverwaltung stellt vermessene 3D-Gebäudemodelle mit
echten Dachformen als Open Data bereit (CC BY 4.0). Einmal lokal backen:

```bash
npm run bake-lod2
```

Das Skript lädt die CityGML-Kacheln für den Kartenausschnitt und schreibt
`public/data/lod2.bin` — die App nutzt sie beim nächsten Start automatisch
statt der extrudierten OSM-Gebäude (Fenster, Floodlight etc. bleiben aktiv).
Falls der automatische Download scheitert: Kacheln von
https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2
manuell laden und `node tools/bake-lod2.mjs --from <ordner>` ausführen.

Den OSM-Cache leert man im Browser (DevTools → IndexedDB → `wuerzburg3d`) oder durch
Erhöhen von `OSM_CACHE_KEY` in `src/config.js`.

## Lizenz / Attribution

Code: MIT. Kartendaten © [OpenStreetMap-Mitwirkende](https://www.openstreetmap.org/copyright) (ODbL).
Gelände: [Mapzen Terrain Tiles / AWS Open Data](https://registry.opendata.aws/terrain-tiles/).

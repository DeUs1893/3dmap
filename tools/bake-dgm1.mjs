// Bakes the official Bavarian 1 m laser-scan terrain (DGM1, GeoTIFF/EPSG:25832)
// into a high-resolution heightmap. The app prefers it over the satellite-based
// terrain.bin — banks, slopes and the fortress moat become survey-accurate and
// match the LoD2 buildings.
//
//   node tools/bake-dgm1.mjs                  # tries to download the tiles
//   node tools/bake-dgm1.mjs --from <dir>     # converts local *.tif files
//   node tools/bake-dgm1.mjs --out <dir>      # output dir (default public/data)
//
// Output: terrain-dgm1.bin + terrain-dgm1.json
// Data source: Bayerische Vermessungsverwaltung, DGM1 (CC BY 4.0)
// https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=dgm1

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { MAP_BBOX, TERRAIN_MARGIN } from '../src/config.js';
import { lonLatToUtm } from '../src/utm.js';

const CELL = 2; // meters per output cell (DGM1 native is 1 m)

// target extent in UTM, slightly beyond the rendered terrain
const margin = TERRAIN_MARGIN + 80;
const corners = [
  lonLatToUtm(MAP_BBOX.west, MAP_BBOX.south),
  lonLatToUtm(MAP_BBOX.east, MAP_BBOX.south),
  lonLatToUtm(MAP_BBOX.west, MAP_BBOX.north),
  lonLatToUtm(MAP_BBOX.east, MAP_BBOX.north),
];
const minE = Math.floor(Math.min(...corners.map((c) => c.easting)) - margin);
const maxE = Math.ceil(Math.max(...corners.map((c) => c.easting)) + margin);
const minN = Math.floor(Math.min(...corners.map((c) => c.northing)) - margin);
const maxN = Math.ceil(Math.max(...corners.map((c) => c.northing)) + margin);

const W = Math.ceil((maxE - minE) / CELL);
const H = Math.ceil((maxN - minN) / CELL);
const grid = new Uint16Array(W * H); // decimeters, row 0 = north

const tiles = [];
for (let e = Math.floor(minE / 1000); e <= Math.floor(maxE / 1000); e++) {
  for (let n = Math.floor(minN / 1000); n <= Math.floor(maxN / 1000); n++) {
    tiles.push({ e, n });
  }
}
console.log(`DGM1: ${tiles.length} Kacheln (1x1 km), Zielraster ${W}x${H} @ ${CELL} m`);

const URL_TEMPLATES = [
  (t) => `https://download1.bayernwolke.de/a/dgm/dgm1/${t.e}_${t.n}.tif`,
  (t) => `https://download1.bayernwolke.de/a/dgm/dgm1/DGM1_32_${t.e}_${t.n}.tif`,
  (t) => `https://download1.bayernwolke.de/a/dgm/dgm1/32_${t.e}_${t.n}.tif`,
];

async function* tiffSources() {
  const fromIdx = process.argv.indexOf('--from');
  if (fromIdx !== -1) {
    const dir = process.argv[fromIdx + 1];
    const files = readdirSync(dir).filter((f) => /\.tiff?$/i.test(f));
    console.log(`Lese ${files.length} lokale GeoTIFFs aus ${dir}`);
    for (const f of files) {
      const buf = readFileSync(`${dir}/${f}`);
      yield buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    return;
  }

  let template = null;
  for (const tpl of URL_TEMPLATES) {
    try {
      const res = await fetch(tpl(tiles[0]), { method: 'HEAD' });
      if (res.ok) {
        template = tpl;
        console.log(`Download-Muster: ${tpl(tiles[0])}`);
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!template) {
    console.error(`
Konnte die DGM1-Kacheln nicht automatisch laden. Manueller Weg:
  1. https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=dgm1
     öffnen und diese Kacheln laden: ${tiles.map((t) => `${t.e}_${t.n}`).join(', ')}
  2. node tools/bake-dgm1.mjs --from <ordner>
`);
    process.exit(1);
  }
  for (const t of tiles) {
    try {
      const res = await fetch(template(t));
      if (!res.ok) {
        console.warn(`Kachel ${t.e}_${t.n}: HTTP ${res.status} — übersprungen`);
        continue;
      }
      console.log(`Kachel ${t.e}_${t.n} geladen`);
      yield await res.arrayBuffer();
    } catch (err) {
      console.warn(`Kachel ${t.e}_${t.n}: ${err.message} — übersprungen`);
    }
  }
}

let filled = 0;
for await (const buf of tiffSources()) {
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const [tMinE, tMinN, tMaxE, tMaxN] = image.getBoundingBox();
  const tw = image.getWidth();
  const th = image.getHeight();
  const data = (await image.readRasters())[0];
  const sx = (tMaxE - tMinE) / tw;
  const sy = (tMaxN - tMinN) / th;

  // copy the overlapping window into the target grid (nearest sample)
  const x0 = Math.max(0, Math.floor((tMinE - minE) / CELL));
  const x1 = Math.min(W - 1, Math.floor((tMaxE - minE) / CELL));
  const y0 = Math.max(0, Math.floor((maxN - tMaxN) / CELL));
  const y1 = Math.min(H - 1, Math.floor((maxN - tMinN) / CELL));
  for (let y = y0; y <= y1; y++) {
    const northing = maxN - (y + 0.5) * CELL;
    const py = Math.min(th - 1, Math.max(0, Math.floor((tMaxN - northing) / sy)));
    for (let x = x0; x <= x1; x++) {
      const easting = minE + (x + 0.5) * CELL;
      const px = Math.min(tw - 1, Math.max(0, Math.floor((easting - tMinE) / sx)));
      const v = data[py * tw + px];
      if (Number.isFinite(v) && v > -100 && v < 1500) {
        grid[y * W + x] = Math.max(0, Math.round(v * 10));
        filled++;
      }
    }
  }
}

const coverage = filled / (W * H);
console.log(`Abdeckung: ${(coverage * 100).toFixed(1)} %`);
if (coverage < 0.5) {
  console.error('Zu wenig Abdeckung — Kacheln prüfen.');
  process.exit(1);
}

// fill small gaps (tile borders) from neighbors
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (grid[y * W + x] !== 0) continue;
    const nb =
      grid[y * W + Math.max(0, x - 1)] ||
      grid[y * W + Math.min(W - 1, x + 1)] ||
      grid[Math.max(0, y - 1) * W + x] ||
      grid[Math.min(H - 1, y + 1) * W + x];
    if (nb) grid[y * W + x] = nb;
  }
}

const outIdx = process.argv.indexOf('--out');
const outDir = outIdx !== -1 ? process.argv[outIdx + 1] : 'public/data';
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/terrain-dgm1.bin`, Buffer.from(grid.buffer));
writeFileSync(
  `${outDir}/terrain-dgm1.json`,
  JSON.stringify({
    mode: 'utm32',
    originE: minE,
    originN: maxN,
    cellSize: CELL,
    width: W,
    height: H,
    unit: 'decimeter',
    encoding: 'uint16-le',
    source: 'Bayerische Vermessungsverwaltung DGM1 (CC BY 4.0)',
  })
);
console.log(
  `Wrote ${outDir}/terrain-dgm1.bin (${(grid.byteLength / 1e6).toFixed(1)} MB) — die App nutzt es automatisch.`
);

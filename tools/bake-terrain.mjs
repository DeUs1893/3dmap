// Bakes a heightmap of the Würzburg area from the AWS Open Data "Terrain Tiles"
// (terrarium encoding) into a compact binary consumed by the app at runtime.
//
// Output:
//   public/data/terrain.bin   Uint16 grid, elevation in decimeters (row-major, north to south)
//   public/data/terrain.json  metadata (mercator tile origin, grid size, zoom)
//
// Usage: node tools/bake-terrain.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';

// Terrain coverage (slightly larger than the city extent so map edges have ground)
const BBOX = { south: 49.762, west: 9.875, north: 49.822, east: 9.985 };
const ZOOM = 14;
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

const xMin = Math.floor(lonToTileX(BBOX.west, ZOOM));
const xMax = Math.floor(lonToTileX(BBOX.east, ZOOM));
const yMin = Math.floor(latToTileY(BBOX.north, ZOOM)); // north => smaller y
const yMax = Math.floor(latToTileY(BBOX.south, ZOOM));
const tilesX = xMax - xMin + 1;
const tilesY = yMax - yMin + 1;
const W = tilesX * 256;
const H = tilesY * 256;

console.log(`Zoom ${ZOOM}, tiles x ${xMin}..${xMax}, y ${yMin}..${yMax} (${tilesX}x${tilesY} = ${tilesX * tilesY} tiles, grid ${W}x${H})`);

async function fetchTile(z, x, y, attempt = 1) {
  const url = TILE_URL(z, x, y);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return fetchTile(z, x, y, attempt + 1);
  }
}

const grid = new Uint16Array(W * H);
let minEle = Infinity;
let maxEle = -Infinity;
const NODATA = -32768;

function decode(png, px, py) {
  const i = (py * png.width + px) * 4;
  return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
}

for (let ty = 0; ty < tilesY; ty++) {
  for (let tx = 0; tx < tilesX; tx++) {
    const X = xMin + tx;
    const Y = yMin + ty;
    const png = PNG.sync.read(await fetchTile(ZOOM, X, Y));
    if (png.width !== 256 || png.height !== 256) throw new Error('unexpected tile size');

    // Some z14 tiles are void in the dataset; fall back to the z13 parent quadrant.
    let parent = null;
    const sample = decode(png, 128, 128);
    if (sample <= NODATA + 1) {
      parent = PNG.sync.read(await fetchTile(ZOOM - 1, X >> 1, Y >> 1));
      console.log(`\nvoid tile ${X}/${Y}, filling from z${ZOOM - 1} parent`);
    }

    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        let ele = decode(png, px, py);
        if (ele <= NODATA + 1 && parent) {
          // bilinear sample of the matching parent quadrant
          const fx = (X % 2) * 128 + px / 2;
          const fy = (Y % 2) * 128 + py / 2;
          const x0 = Math.min(255, Math.floor(fx)), y0 = Math.min(255, Math.floor(fy));
          const x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
          const ax = fx - x0, ay = fy - y0;
          ele =
            decode(parent, x0, y0) * (1 - ax) * (1 - ay) +
            decode(parent, x1, y0) * ax * (1 - ay) +
            decode(parent, x0, y1) * (1 - ax) * ay +
            decode(parent, x1, y1) * ax * ay;
        }
        grid[(ty * 256 + py) * W + tx * 256 + px] = Math.max(0, Math.round(ele * 10)); // decimeters
        if (ele < minEle) minEle = ele;
        if (ele > maxEle) maxEle = ele;
      }
    }
    process.stdout.write(`tile ${ty * tilesX + tx + 1}/${tilesX * tilesY}\r`);
  }
}

console.log(`\nElevation range: ${minEle.toFixed(1)}m .. ${maxEle.toFixed(1)}m`);

mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/terrain.bin', Buffer.from(grid.buffer));
writeFileSync(
  'public/data/terrain.json',
  JSON.stringify({
    zoom: ZOOM,
    tileXMin: xMin,
    tileYMin: yMin,
    width: W,
    height: H,
    unit: 'decimeter',
    encoding: 'uint16-le',
    bbox: BBOX,
  }, null, 2)
);
console.log(`Wrote public/data/terrain.bin (${((grid.byteLength) / 1e6).toFixed(1)} MB) + terrain.json`);

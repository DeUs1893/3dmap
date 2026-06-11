// Bakes official Bavarian LoD2 building models (CityGML, EPSG:25832) into a
// compact binary the app loads instead of extruded OSM footprints.
//
//   node tools/bake-lod2.mjs                  # tries to download the tiles
//   node tools/bake-lod2.mjs --from <dir>     # converts local *.gml files
//
// Output: public/data/lod2.bin + public/data/lod2.json
// Data source: Bayerische Vermessungsverwaltung, LoD2 (CC BY 4.0)
// https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { MAP_BBOX, BASE_ELEVATION } from '../src/config.js';
import { project } from '../src/geo.js';
import { utmToLonLat, lonLatToUtm } from '../src/utm.js';

// self check: round trip must close within centimeters
{
  const ref = lonLatToUtm(9.93164, 49.7927);
  const back = utmToLonLat(ref.easting, ref.northing);
  const errM = Math.hypot((back.lon - 9.93164) * 71866, (back.lat - 49.7927) * 111194);
  if (errM > 0.05) throw new Error(`UTM round trip off by ${errM.toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
// Tile list + download
// ---------------------------------------------------------------------------
const sw = lonLatToUtm(MAP_BBOX.west, MAP_BBOX.south);
const ne = lonLatToUtm(MAP_BBOX.east, MAP_BBOX.north);
const tiles = [];
for (let e = Math.floor(sw.easting / 2000) * 2; e <= Math.floor(ne.easting / 2000) * 2; e += 2) {
  for (let n = Math.floor(sw.northing / 2000) * 2; n <= Math.floor(ne.northing / 2000) * 2; n += 2) {
    tiles.push({ e, n });
  }
}
console.log(`Map extent needs ${tiles.length} LoD2 tiles (2x2 km):`, tiles.map((t) => `${t.e}_${t.n}`).join(', '));

const URL_TEMPLATES = [
  (t) => `https://download1.bayernwolke.de/a/lod2/citygml/${t.e}_${t.n}.gml`,
  (t) => `https://download1.bayernwolke.de/a/lod2/citygml/LoD2_32_${t.e}_${t.n}.gml`,
  (t) => `https://download1.bayernwolke.de/a/lod2/citygml/LoD2_32_${t.e}_${t.n}_1.gml`,
  (t) => `https://geodaten.bayern.de/odd/a/lod2/citygml/${t.e}_${t.n}.gml`,
];

async function fetchTiles() {
  const fromIdx = process.argv.indexOf('--from');
  if (fromIdx !== -1) {
    const dir = process.argv[fromIdx + 1];
    const files = readdirSync(dir).filter((f) => f.endsWith('.gml'));
    console.log(`Reading ${files.length} local GML files from ${dir}`);
    return files.map((f) => readFileSync(`${dir}/${f}`, 'utf8'));
  }

  // probe templates with the first tile
  let template = null;
  for (const tpl of URL_TEMPLATES) {
    try {
      const res = await fetch(tpl(tiles[0]), { method: 'HEAD' });
      if (res.ok) {
        template = tpl;
        console.log(`Using download pattern: ${tpl(tiles[0])}`);
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!template) {
    console.error(`
Konnte die LoD2-Tiles nicht automatisch herunterladen (URL-Muster unbekannt
oder Server nicht erreichbar). Manueller Weg:

  1. https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2
     öffnen, im Kartenausschnitt Würzburg diese Kacheln laden:
     ${tiles.map((t) => `${t.e}_${t.n}`).join(', ')}
  2. Die .gml-Dateien in einen Ordner legen, dann:
     node tools/bake-lod2.mjs --from <ordner>
`);
    process.exit(1);
  }

  const out = [];
  for (const t of tiles) {
    try {
      const res = await fetch(template(t));
      if (!res.ok) {
        console.warn(`tile ${t.e}_${t.n}: HTTP ${res.status} — skipped`);
        continue;
      }
      out.push(await res.text());
      console.log(`tile ${t.e}_${t.n}: ${(out[out.length - 1].length / 1e6).toFixed(1)} MB`);
    } catch (err) {
      console.warn(`tile ${t.e}_${t.n}: ${err.message} — skipped`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CityGML parsing → triangle soup in local map coordinates
// ---------------------------------------------------------------------------
const SURFACE_RE = /<(?:\w+:)?(RoofSurface|WallSurface|GroundSurface)[\s\S]*?<\/(?:\w+:)?\1>/g;
const BUILDING_SPLIT_RE = /<(?:\w+:)?Building\s/g;
const POSLIST_RE = /<(?:\w+:)?posList[^>]*>([\s\S]*?)<\/(?:\w+:)?posList>/g;

function parsePolygons(xml, kind) {
  const polys = [];
  for (const m of xml.matchAll(POSLIST_RE)) {
    const nums = m[1].trim().split(/\s+/).map(Number);
    if (nums.length < 12 || nums.length % 3 !== 0) continue;
    const ring = [];
    for (let i = 0; i < nums.length; i += 3) {
      ring.push([nums[i], nums[i + 1], nums[i + 2]]);
    }
    polys.push({ ring, kind });
  }
  return polys;
}

// triangulate a planar 3D ring: project to its dominant plane, earcut in 2D
function triangulate3D(ring) {
  const pts = ring.slice();
  // drop closing duplicates (CityGML rings repeat the first point)
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;
  while (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
  if (pts.length < 3) return [];
  // Newell normal
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1, z1] = pts[i];
    const [x2, y2, z2] = pts[(i + 1) % pts.length];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const drop = az >= ax && az >= ay ? 2 : ay >= ax ? 1 : 0;
  const flat = pts.map((p) => {
    const q = p.filter((_, i) => i !== drop);
    return new THREE.Vector2(q[0], q[1]);
  });
  let tris;
  try {
    tris = THREE.ShapeUtils.triangulateShape(flat, []);
  } catch {
    return [];
  }
  // keep the source polygon's outward orientation: the axis-drop projection can
  // mirror the winding, so re-align each triangle with the Newell normal
  return tris.map(([a, b, c]) => {
    const p = pts[a], q = pts[b], r = pts[c];
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
    const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    const dot =
      (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    return dot >= 0 ? [p, q, r] : [p, r, q];
  });
}

const gmls = await fetchTiles();
if (!gmls.length) {
  console.error('Keine Tiles geladen.');
  process.exit(1);
}

// local-extent filter
const localRect = (() => {
  const a = project(MAP_BBOX.west, MAP_BBOX.south);
  const b = project(MAP_BBOX.east, MAP_BBOX.north);
  const m = 450;
  return {
    minX: Math.min(a.x, b.x) - m, maxX: Math.max(a.x, b.x) + m,
    minZ: Math.min(a.z, b.z) - m, maxZ: Math.max(a.z, b.z) + m,
  };
})();

const KIND_FLAG = { GroundSurface: 0, RoofSurface: 0, WallSurface: 1 };
const ROOF_KIND = { RoofSurface: 1, WallSurface: 0, GroundSurface: 2 };

const positions = []; // local dm, int16
const wins = []; // wall uv dm, uint16
const flags = []; // 0 roof / 1 wall / 2 ground
const ranges = []; // per building {s, n, cx, cz, minH, eave, seed}

let totalBuildings = 0;
for (const gml of gmls) {
  const chunks = gml.split(BUILDING_SPLIT_RE).slice(1);
  for (const chunk of chunks) {
    const polys = [];
    for (const sm of chunk.matchAll(SURFACE_RE)) {
      polys.push(...parsePolygons(sm[0], sm[1]));
    }
    if (!polys.length) continue;

    // centroid + reject buildings outside the map
    let cx = 0, cz = 0, cn = 0, minH = Infinity, eave = -Infinity;
    const converted = polys.map((p) => ({
      kind: p.kind,
      ring: p.ring.map(([e, n, h]) => {
        const { lon, lat } = utmToLonLat(e, n);
        const loc = project(lon, lat);
        cx += loc.x; cz += loc.z; cn++;
        if (h < minH) minH = h;
        if (p.kind === 'WallSurface' && h > eave) eave = h;
        return [loc.x, h - BASE_ELEVATION, loc.z];
      }),
    }));
    cx /= cn; cz /= cn;
    if (cx < localRect.minX || cx > localRect.maxX || cz < localRect.minZ || cz > localRect.maxZ) continue;
    if (!Number.isFinite(minH)) continue;
    if (eave === -Infinity) eave = minH + 6;

    const start = positions.length / 3;
    for (const poly of converted) {
      const flag = ROOF_KIND[poly.kind] ?? 0;
      // wall window coordinates: meters along the wall's horizontal axis,
      // zero-based per surface (no wrapping — interpolation must stay local)
      let dirX = 1, dirZ = 0;
      let uMin = 0;
      if (flag === 0) {
        const a = poly.ring[0];
        let best = 0;
        for (let i = 1; i < poly.ring.length; i++) {
          const dx = poly.ring[i][0] - a[0];
          const dz = poly.ring[i][2] - a[2];
          const d = dx * dx + dz * dz;
          if (d > best) {
            best = d;
            dirX = dx; dirZ = dz;
          }
        }
        const len = Math.hypot(dirX, dirZ) || 1;
        dirX /= len; dirZ /= len;
        uMin = Infinity;
        for (const [x, , z] of poly.ring) {
          uMin = Math.min(uMin, x * dirX + z * dirZ);
        }
      }
      for (const tri of triangulate3D(poly.ring)) {
        // drop slivers that collapse to zero area after 0.1 m quantization
        const ux = tri[1][0] - tri[0][0], uy = tri[1][1] - tri[0][1], uz = tri[1][2] - tri[0][2];
        const vx = tri[2][0] - tri[0][0], vy = tri[2][1] - tri[0][1], vz = tri[2][2] - tri[0][2];
        const cx2 = uy * vz - uz * vy, cy2 = uz * vx - ux * vz, cz2 = ux * vy - uy * vx;
        if (cx2 * cx2 + cy2 * cy2 + cz2 * cz2 < 0.0016) continue; // area < 0.02 m²
        for (const [x, y, z] of tri) {
          positions.push(Math.round(x * 10), Math.round(y * 10), Math.round(z * 10));
          const u = flag === 0 ? x * dirX + z * dirZ - uMin : 0;
          const v = y - (minH - BASE_ELEVATION);
          wins.push(Math.min(65535, Math.max(0, Math.round(u * 10))), Math.max(0, Math.round(v * 10)));
          flags.push(flag === 0 ? 1 : 0); // wall=1, roof/ground=0 for the shader
        }
      }
    }
    const count = positions.length / 3 - start;
    if (count === 0) continue;
    ranges.push({
      s: start,
      n: count,
      cx: Math.round(cx * 10) / 10,
      cz: Math.round(cz * 10) / 10,
      minH: Math.round((minH - BASE_ELEVATION) * 10) / 10,
      eave: Math.round((eave - minH) * 10) / 10,
    });
    totalBuildings++;
  }
}

console.log(`Parsed ${totalBuildings} buildings, ${positions.length / 3} vertices`);
if (!totalBuildings) {
  console.error('Keine Gebäude im Kartenausschnitt gefunden — Tiles prüfen.');
  process.exit(1);
}

const vertCount = positions.length / 3;
const bin = Buffer.alloc(vertCount * (6 + 4 + 1));
let off = 0;
for (let i = 0; i < vertCount * 3; i++) {
  bin.writeInt16LE(Math.max(-32768, Math.min(32767, positions[i])), off);
  off += 2;
}
for (let i = 0; i < vertCount * 2; i++) {
  bin.writeUInt16LE(Math.min(65535, wins[i]), off);
  off += 2;
}
for (let i = 0; i < vertCount; i++) {
  bin.writeUInt8(flags[i], off);
  off += 1;
}

const outIdx = process.argv.indexOf('--out');
const outDir = outIdx !== -1 ? process.argv[outIdx + 1] : 'public/data';
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/lod2.bin`, bin);
writeFileSync(`${outDir}/lod2.json`, JSON.stringify({
  version: 1,
  source: 'Bayerische Vermessungsverwaltung LoD2 (CC BY 4.0)',
  vertexCount: vertCount,
  unit: 'decimeter',
  buildings: ranges,
}));
console.log(`Wrote ${outDir}/lod2.bin (${(bin.length / 1e6).toFixed(1)} MB) + lod2.json — die App nutzt sie automatisch.`);

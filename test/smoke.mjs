// Headless smoke test: terrain sampling against known Würzburg elevations,
// plus geometry generation for buildings/roads with synthetic OSM features.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

// minimal browser shims
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('data/terrain')) {
    const path = `public/data/terrain.${String(url).endsWith('.json') ? 'json' : 'bin'}`;
    const buf = readFileSync(path);
    return {
      ok: true,
      json: async () => JSON.parse(buf.toString()),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }
  return realFetch(url);
};

const { loadTerrainData, sampleElevation, groundY } = await import('../src/terrain.js');
const { project } = await import('../src/geo.js');
const { buildBuildings } = await import('../src/buildings.js');
const { buildRoads } = await import('../src/roads.js');
const { parseOSM } = await import('../src/osm.js');

await loadTerrainData('');

// --- terrain plausibility (meters above sea level) ---
const checks = [
  { name: 'Main river bank (Alte Mainbrücke)', lon: 9.9258, lat: 49.7933, min: 160, max: 180 },
  { name: 'Festung Marienberg hill', lon: 9.9215, lat: 49.7903, min: 230, max: 290 },
  { name: 'Residenz', lon: 9.9394, lat: 49.7926, min: 165, max: 195 },
];
for (const c of checks) {
  const ele = sampleElevation(c.lon, c.lat);
  assert(ele >= c.min && ele <= c.max, `${c.name}: ${ele.toFixed(1)}m outside [${c.min}, ${c.max}]`);
  console.log(`ok terrain  ${c.name}: ${ele.toFixed(1)} m`);
}

// fortress must sit well above the river
const fp = project(9.9215, 49.7903);
const rp = project(9.9258, 49.7933);
assert(groundY(fp.x, fp.z) - groundY(rp.x, rp.z) > 50, 'fortress not above river');
console.log('ok terrain  fortress rises above the Main valley');

// --- parse + geometry with synthetic OSM payload ---
const synthetic = {
  elements: [
    {
      type: 'way',
      id: 1,
      tags: { building: 'yes', 'building:levels': '3' },
      geometry: [
        { lon: 9.929, lat: 49.794 },
        { lon: 9.9295, lat: 49.794 },
        { lon: 9.9295, lat: 49.7943 },
        { lon: 9.929, lat: 49.7943 },
        { lon: 9.929, lat: 49.794 },
      ],
    },
    {
      type: 'way',
      id: 2,
      tags: { highway: 'primary', bridge: 'yes' },
      geometry: [
        { lon: 9.924, lat: 49.7931 },
        { lon: 9.9258, lat: 49.7933 },
        { lon: 9.9275, lat: 49.7935 },
      ],
    },
  ],
};
const parsed = parseOSM(synthetic);
assert.equal(parsed.buildings.length, 1);
assert.equal(parsed.roads.length, 1);
assert(parsed.roads[0].bridge, 'bridge flag lost');

const bMesh = await buildBuildings(parsed.buildings);
const bPos = bMesh.geometry.attributes.position;
assert(bPos.count >= 30, 'building geometry too small');
for (let i = 0; i < bPos.count; i++) {
  assert(Number.isFinite(bPos.getY(i)), 'NaN in building geometry');
}
// roof must be ~levels*3.3+1.5 above terrain
let maxY = -Infinity;
let minY = Infinity;
for (let i = 0; i < bPos.count; i++) {
  maxY = Math.max(maxY, bPos.getY(i));
  minY = Math.min(minY, bPos.getY(i));
}
assert(maxY - minY > 8 && maxY - minY < 30, `building extent odd: ${(maxY - minY).toFixed(1)}m`);
console.log(`ok geometry building: ${bPos.count} verts, vertical extent ${(maxY - minY).toFixed(1)} m`);

const { mesh: rMesh, trafficPaths } = buildRoads(parsed.roads, []);
const rPos = rMesh.geometry.attributes.position;
assert(rPos.count > 8, 'road geometry too small');
for (let i = 0; i < rPos.count; i++) {
  assert(Number.isFinite(rPos.getY(i)), 'NaN in road geometry');
}
assert.equal(trafficPaths.length, 1);
console.log(`ok geometry road ribbon: ${rPos.count} verts, ${trafficPaths.length} traffic path`);

// --- roof shapes, building:part, min_height ---
const roofSynthetic = {
  elements: [
    {
      type: 'way', id: 10, tags: { building: 'cathedral', name: 'Hull' },
      geometry: [
        { lon: 9.93, lat: 49.794 }, { lon: 9.9312, lat: 49.794 },
        { lon: 9.9312, lat: 49.7946 }, { lon: 9.93, lat: 49.7946 }, { lon: 9.93, lat: 49.794 },
      ],
    },
    {
      type: 'way', id: 11,
      tags: { 'building:part': 'yes', height: '20', 'roof:shape': 'gabled', 'roof:height': '6' },
      geometry: [
        { lon: 9.9301, lat: 49.7941 }, { lon: 9.9311, lat: 49.7941 },
        { lon: 9.9311, lat: 49.7945 }, { lon: 9.9301, lat: 49.7945 }, { lon: 9.9301, lat: 49.7941 },
      ],
    },
    {
      type: 'way', id: 12,
      tags: { 'building:part': 'yes', height: '18', min_height: '12' },
      geometry: [
        { lon: 9.932, lat: 49.7941 }, { lon: 9.9322, lat: 49.7941 },
        { lon: 9.9322, lat: 49.7943 }, { lon: 9.932, lat: 49.7943 }, { lon: 9.932, lat: 49.7941 },
      ],
    },
  ],
};
const roofParsed = parseOSM(roofSynthetic);
assert.equal(roofParsed.parts.length, 2, 'parts not parsed');
assert(roofParsed.buildings[0].hasParts, 'hull not flagged as detailed by parts');
assert.equal(roofParsed.parts[0].roof.shape, 'gabled');
assert.equal(roofParsed.parts[1].minHeight, 12);
const partMesh = await buildBuildings(roofParsed.parts);
const pPos = partMesh.geometry.attributes.position;
for (let i = 0; i < pPos.count; i++) {
  assert(Number.isFinite(pPos.getX(i)) && Number.isFinite(pPos.getY(i)), 'NaN in roof/part geometry');
}
console.log(`ok geometry roofs + parts: ${pPos.count} verts`);

// --- Overpass query regression guards ---
const { buildQuery } = await import('../src/osm.js');
const query = buildQuery();
assert(/out geom;\s*$/.test(query), 'query must end with full "out geom"');
assert(!query.includes('out tags'), '"out tags" strips relation members — must not be used');
assert(query.includes('waterway'), 'water queries missing');
console.log('ok overpass query uses full geometry output');

// --- river centerline parsing (water fallback source) ---
const riverParsed = parseOSM({
  elements: [
    {
      type: 'way', id: 30, tags: { waterway: 'river', width: '90' },
      geometry: [
        { lon: 9.925, lat: 49.785 }, { lon: 9.926, lat: 49.793 }, { lon: 9.928, lat: 49.8 },
      ],
    },
  ],
});
assert.equal(riverParsed.riverLines.length, 1, 'river centerline not parsed');
assert.equal(riverParsed.riverLines[0].width, 90, 'river width tag ignored');
console.log('ok river centerline fallback parsing');

// --- multipolygon relation stitching (Residenz-style split outer ways) ---
const relSynthetic = {
  elements: [
    {
      type: 'relation', id: 20, tags: { building: 'palace', name: 'Residenz' },
      members: [
        {
          type: 'way', role: 'outer',
          geometry: [
            { lon: 9.938, lat: 49.792 }, { lon: 9.94, lat: 49.792 }, { lon: 9.94, lat: 49.7928 },
          ],
        },
        {
          // reversed order + connects at the head of the first segment
          type: 'way', role: 'outer',
          geometry: [
            { lon: 9.938, lat: 49.792 }, { lon: 9.938, lat: 49.7928 }, { lon: 9.94, lat: 49.7928 },
          ],
        },
      ],
    },
  ],
};
const relParsed = parseOSM(relSynthetic);
assert.equal(relParsed.buildings.length, 1, 'split relation outer not stitched');
assert(relParsed.buildings[0].outer.length >= 4, 'stitched ring too small');
const relMesh = await buildBuildings(relParsed.buildings);
assert(relMesh.geometry.attributes.position.count > 12, 'relation building has no geometry');
console.log('ok relation stitching (split outer ways → 1 building)');

// --- hip roof over courtyard footprint (Residenz-style) ---
const ring = (cx, cy, w, h) => [
  { lon: cx - w, lat: cy - h }, { lon: cx + w, lat: cy - h },
  { lon: cx + w, lat: cy + h }, { lon: cx - w, lat: cy + h }, { lon: cx - w, lat: cy - h },
];
const palaceParsed = parseOSM({
  elements: [
    {
      type: 'relation', id: 40,
      tags: { building: 'palace', height: '22', 'building:colour': '#d9c8a0' },
      members: [
        { type: 'way', role: 'outer', geometry: ring(9.9394, 49.7926, 0.0011, 0.0005) },
        { type: 'way', role: 'inner', geometry: ring(9.9394, 49.7926, 0.0004, 0.0002) },
      ],
    },
  ],
});
assert.equal(palaceParsed.buildings.length, 1);
assert.equal(palaceParsed.buildings[0].wallColor, '#d9c8a0');
assert.equal(palaceParsed.buildings[0].holes.length, 1, 'courtyard hole lost');
const palaceMesh = await buildBuildings(palaceParsed.buildings);
const palPos = palaceMesh.geometry.attributes.position;
let palMax = -Infinity;
for (let i = 0; i < palPos.count; i++) {
  assert(Number.isFinite(palPos.getY(i)), 'NaN in palace geometry');
  palMax = Math.max(palMax, palPos.getY(i));
}
assert(palPos.count > 200, `palace roof not subdivided (${palPos.count} verts)`);
console.log(`ok palace courtyard hip roof: ${palPos.count} verts, top ${palMax.toFixed(1)}`);

// --- solar position ---
const { sunPosition } = await import('../src/sun.js');
const noon = sunPosition(new Date(Date.UTC(2026, 5, 11, 11, 15)), 49.79, 9.93);
assert(noon.elevation > 60 && noon.elevation < 66, `june noon elevation odd: ${noon.elevation}`);
assert(Math.abs(noon.azimuth - 180) < 10, `june noon azimuth odd: ${noon.azimuth}`);
const night = sunPosition(new Date(Date.UTC(2026, 5, 11, 23, 0)), 49.79, 9.93);
assert(night.elevation < -10, 'sun should be down at night');
console.log(`ok sun position: noon el ${noon.elevation.toFixed(1)}°, az ${noon.azimuth.toFixed(1)}°`);

// --- polygon / polyline clipping ---
const THREE = await import('three');
const { clipRingToRect, clipPathToRect } = await import('../src/polyutil.js');
const rect = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };
const bigRing = [
  new THREE.Vector2(-50, -50),
  new THREE.Vector2(150, -50),
  new THREE.Vector2(150, 150),
  new THREE.Vector2(-50, 150),
];
const clipped = clipRingToRect(bigRing, rect);
assert(clipped.length >= 4, 'clipped ring lost shape');
for (const p of clipped) {
  assert(p.x >= -0.01 && p.x <= 100.01 && p.y >= -0.01 && p.y <= 100.01, 'clip out of rect');
}
const outsideRing = [
  new THREE.Vector2(200, 200),
  new THREE.Vector2(300, 200),
  new THREE.Vector2(300, 300),
];
assert.equal(clipRingToRect(outsideRing, rect).length, 0, 'fully-outside ring not removed');
const path = [new THREE.Vector2(-50, 50), new THREE.Vector2(50, 50), new THREE.Vector2(200, 50)];
const pieces = clipPathToRect(path, rect);
assert.equal(pieces.length, 1, 'path should yield one inside piece');
for (const p of pieces[0]) {
  assert(p.x >= 0 && p.x <= 100, 'path clip out of rect');
}
console.log('ok clipping ring + path');

// --- trees: instanced trunk+crown merge must produce valid geometry ---
{
  const { buildGreenery } = await import('../src/greenery.js');
  const greenery = buildGreenery([
    {
      kind: 'forest',
      id: 99,
      outer: [
        [9.91, 49.787], [9.918, 49.787], [9.918, 49.792], [9.91, 49.792], [9.91, 49.787],
      ],
    },
  ]);
  assert(greenery.trees, 'tree mesh missing (geometry merge failed?)');
  assert(greenery.trees.geometry?.attributes?.position?.count > 0, 'tree geometry empty');
  assert(greenery.trees.count > 50, `too few trees scattered: ${greenery.trees.count}`);
  console.log(`ok trees: ${greenery.trees.count} instances, merged geometry valid`);
}

// --- LoD2 pipeline end-to-end (synthetic CityGML → bake → loader) ---
{
  const { execSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/lod2-`);
  const e = 566900, n0 = 5516560, g = 172, eave = 180, ridge = 184;
  const pl = (pts) => pts.map((p) => p.join(' ')).join(' ');
  const surf = (kind, rings) =>
    rings
      .map(
        (r) =>
          `<bldg:boundedBy><bldg:${kind}><gml:Polygon><gml:exterior><gml:LinearRing>` +
          `<gml:posList srsDimension="3">${pl(r)}</gml:posList>` +
          `</gml:LinearRing></gml:exterior></gml:Polygon></bldg:${kind}></bldg:boundedBy>`
      )
      .join('\n');
  const gml = `<?xml version="1.0"?><core:CityModel xmlns:bldg="y" xmlns:gml="z">
<core:cityObjectMember><bldg:Building gml:id="T1">
${surf('WallSurface', [
  [[e, n0, g], [e + 10, n0, g], [e + 10, n0, eave], [e, n0, eave], [e, n0, g]],
  [[e, n0, g], [e, n0 + 6, g], [e, n0 + 3, ridge], [e, n0, eave], [e, n0, g]],
])}
${surf('RoofSurface', [
  [[e, n0, eave], [e + 10, n0, eave], [e + 10, n0 + 3, ridge], [e, n0 + 3, ridge], [e, n0, eave]],
])}
${surf('GroundSurface', [
  [[e, n0, g], [e, n0 + 6, g], [e + 10, n0 + 6, g], [e + 10, n0, g], [e, n0, g]],
])}
</bldg:Building></core:cityObjectMember></core:CityModel>`;
  wf(`${dir}/t.gml`, gml);
  execSync(`node tools/bake-lod2.mjs --from ${dir} --out ${dir}/out`, { stdio: 'pipe' });

  const innerFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('data/lod2')) {
      const buf = readFileSync(`${dir}/out/lod2.${u.endsWith('.json') ? 'json' : 'bin'}`);
      return {
        ok: true,
        json: async () => JSON.parse(buf.toString()),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }
    return innerFetch(url);
  };
  const { loadLOD2 } = await import('../src/lod2.js');
  const lod2 = await loadLOD2('');
  globalThis.fetch = innerFetch;
  assert(lod2, 'LoD2 loader returned null');
  assert.equal(lod2.count, 1);
  const lp = lod2.mesh.geometry.attributes.position;
  let top = -Infinity;
  for (let i = 0; i < lp.count; i++) {
    assert(Number.isFinite(lp.getX(i)) && Number.isFinite(lp.getY(i)), 'NaN in LoD2 geometry');
    top = Math.max(top, lp.getY(i));
  }
  // gabled fixture: ridge 12 m above its base, building re-grounded onto terrain
  const span = top - Math.min(...Array.from({ length: lp.count }, (_, i) => lp.getY(i)));
  assert(span > 10 && span < 14, `LoD2 vertical span odd: ${span.toFixed(1)} m`);
  console.log(`ok LoD2 pipeline: bake + loader, ${lp.count} verts, ridge span ${span.toFixed(1)} m`);
}

// --- DGM1 pipeline end-to-end (synthetic GeoTIFF → bake → utm32 terrain sampling) ---
// runs last: it swaps the globally loaded terrain to the high-res variant
{
  const { execSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { writeArrayBuffer } = await import('geotiff');
  const { lonLatToUtm } = await import('../src/utm.js');
  const { MAP_BBOX } = await import('../src/config.js');

  // one synthetic tile covering the whole extent at 4 m, constant slope field
  const m = 800;
  const c1 = lonLatToUtm(MAP_BBOX.west, MAP_BBOX.south);
  const c2 = lonLatToUtm(MAP_BBOX.east, MAP_BBOX.north);
  const minE = Math.floor(Math.min(c1.easting, c2.easting)) - m;
  const maxE = Math.ceil(Math.max(c1.easting, c2.easting)) + m;
  const minN = Math.floor(Math.min(c1.northing, c2.northing)) - m;
  const maxN = Math.ceil(Math.max(c1.northing, c2.northing)) + m;
  const scale = 4;
  const tw = Math.ceil((maxE - minE) / scale);
  const th = Math.ceil((maxN - minN) / scale);
  const eleAt = (E, N) => 180 + (E - minE) * 0.002 + (N - minN) * 0.001; // stays < 255 (8-bit fixture)
  const data = new Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      data[y * tw + x] = Math.round(eleAt(minE + (x + 0.5) * scale, maxN - (y + 0.5) * scale));
    }
  }
  const tiffBuf = await writeArrayBuffer(data, {
    height: th,
    width: tw,
    ModelPixelScale: [scale, scale, 0],
    ModelTiepoint: [0, 0, 0, minE, maxN, 0],
    ProjectedCSTypeGeoKey: 25832, // without a CRS geokey the writer overrides the tiepoint
  });
  const dir = mkdtempSync(`${tmpdir()}/dgm1-`);
  wf(`${dir}/tile.tif`, Buffer.from(tiffBuf));
  execSync(`node tools/bake-dgm1.mjs --from ${dir} --out ${dir}/out`, { stdio: 'pipe' });

  const innerFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('terrain-dgm1')) {
      const buf = readFileSync(`${dir}/out/terrain-dgm1.${u.endsWith('.json') ? 'json' : 'bin'}`);
      return {
        ok: true,
        json: async () => JSON.parse(buf.toString()),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }
    return { ok: false };
  };
  const terrain = await import('../src/terrain.js');
  await terrain.loadTerrainData('');
  globalThis.fetch = innerFetch;
  assert(terrain.isHighResTerrain(), 'DGM1 terrain not active');
  const probe = { lon: 9.9293, lat: 49.7935 };
  const utm = lonLatToUtm(probe.lon, probe.lat);
  const expected = eleAt(utm.easting, utm.northing);
  const got = terrain.sampleElevation(probe.lon, probe.lat);
  assert(Math.abs(got - expected) < 1.5, `DGM1 sample off: ${got.toFixed(1)} vs ${expected.toFixed(1)}`);
  console.log(`ok DGM1 pipeline: bake + utm32 sampling (${got.toFixed(1)} m ≈ ${expected.toFixed(1)} m)`);
}

console.log('\nAll smoke tests passed.');

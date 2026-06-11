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

console.log('\nAll smoke tests passed.');

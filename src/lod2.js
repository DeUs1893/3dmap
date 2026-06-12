// Loader for the baked Bavarian LoD2 building models (tools/bake-lod2.mjs).
// If public/data/lod2.bin exists, these surveyed models (real roof shapes)
// replace the extruded OSM buildings. Shares the OSM building material so
// windows, floodlight and facade detail keep working.
import * as THREE from 'three';
import { LANDMARKS } from './config.js';
import { project, hash01 } from './geo.js';
import { groundY } from './terrain.js';
import { createBuildingMaterial, isStone, windowsAllowed } from './buildings.js';
import { projectRing, pointInRing } from './polyutil.js';

const WALL_PALETTE = [0xc9b896, 0xbfae90, 0xd2c2a4, 0xb3a288, 0xc4ad9d, 0xa9ab97, 0xcbb6a8, 0xbdb09a].map(
  (c) => new THREE.Color(c)
);
const ROOF_PALETTE = [0x9a5743, 0x8d4f3d, 0xa05f48, 0x86503f, 0x6e4636, 0x7a5a48, 0x5f5d63].map(
  (c) => new THREE.Color(c)
);
const STONE = new THREE.Color(0xb6a890);
const STONE_ROOF = new THREE.Color(0x77705f);

// Spatial index over OSM footprints so surveyed LoD2 buildings inherit their
// type (church towers must not get the residential window grid …)
function buildTypeIndex(osmBuildings) {
  const CELL = 80;
  const cells = new Map();
  const entries = [];
  for (const b of osmBuildings) {
    if (!b.type || b.type === 'yes') continue;
    const ring = projectRing(b.outer);
    if (ring.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const v of ring) {
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.y); maxZ = Math.max(maxZ, v.y);
    }
    const idx = entries.push({ ring, minX, maxX, minZ, maxZ, type: b.type }) - 1;
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const key = `${cx}_${cz}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(idx);
      }
    }
  }
  return (x, z) => {
    const bucket = cells.get(`${Math.floor(x / CELL)}_${Math.floor(z / CELL)}`);
    if (!bucket) return null;
    for (const i of bucket) {
      const e = entries[i];
      if (x >= e.minX && x <= e.maxX && z >= e.minZ && z <= e.maxZ && pointInRing(x, z, e.ring)) {
        return e.type;
      }
    }
    return null;
  };
}

export async function loadLOD2(baseUrl = '', osmBuildings = [], waterMask = null) {
  let meta;
  let bin;
  try {
    const metaRes = await fetch(`${baseUrl}data/lod2.json`);
    if (!metaRes.ok) return null;
    meta = await metaRes.json();
    const binRes = await fetch(`${baseUrl}data/lod2.bin`);
    if (!binRes.ok) return null;
    bin = await binRes.arrayBuffer();
  } catch {
    return null;
  }

  const n = meta.vertexCount;
  if (!n || bin.byteLength < n * 11) {
    console.warn('[lod2] Datei unvollständig — nutze OSM-Gebäude');
    return null;
  }
  const qPos = new Int16Array(bin, 0, n * 3);
  const qWin = new Uint16Array(bin, n * 6, n * 2);
  const qFlag = new Uint8Array(bin, n * 10, n);

  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const win = new Float32Array(n * 2);
  const extra = new Float32Array(n * 4);

  const landmarkPts = LANDMARKS.map((lm) => ({ ...project(lm.lon, lm.lat), r: lm.floodRadius }));
  const typeAt = buildTypeIndex(osmBuildings);
  const tmp = new THREE.Color();
  let stoneCount = 0;
  let bridgeSkips = 0;

  for (const b of meta.buildings) {
    const seed = hash01(Math.round(b.cx * 7 + b.cz * 13));
    // Align the surveyed base with our (coarser) terrain. Long structures like
    // the fortress walls span slopes, so sample the ground under many vertices
    // and sink the base to the lowest point — buried beats floating.
    let minGround = groundY(b.cx, b.cz);
    let samples = 0;
    let waterHits = 0;
    const stride = Math.max(1, Math.floor(b.n / 32));
    for (let i = b.s; i < b.s + b.n; i += stride) {
      const x = qPos[i * 3] / 10;
      const z = qPos[i * 3 + 2] / 10;
      const g = groundY(x, z);
      if (g < minGround) minGround = g;
      samples++;
      if (waterMask && waterMask(x, z) !== null) waterHits++;
    }
    // bridge structures span the river — the road layer already renders them
    // properly (deck, piers, parapets); the "building" version would sink and
    // get roof-colored, so skip it
    if (samples > 0 && waterHits / samples > 0.4) {
      bridgeSkips++;
      continue; // vertices stay zeroed → zero-area triangles, invisible
    }
    const yShift = minGround - b.minH - 0.4;
    let flood = 0;
    for (const lm of landmarkPts) {
      const d = Math.hypot(b.cx - lm.x, b.cz - lm.z);
      if (d < lm.r) flood = Math.max(flood, 1 - (d / lm.r) * 0.5);
    }
    // churches & castles: stone look; windows only where real storeys fit
    // (palaces keep their baroque window rows, garden walls get none)
    const osmType = typeAt(b.cx, b.cz);
    const stone = isStone(osmType);
    if (stone) stoneCount++;
    const wallC = tmp
      .copy(stone ? STONE : WALL_PALETTE[Math.floor(seed * WALL_PALETTE.length)])
      .multiplyScalar(0.85 + hash01(Math.round(b.cx * 31)) * 0.3)
      .clone();
    const roofC = (stone
      ? STONE_ROOF
      : ROOF_PALETTE[Math.floor(hash01(Math.round(b.cz * 17)) * ROOF_PALETTE.length)]
    )
      .clone()
      .multiplyScalar(0.85 + hash01(Math.round(b.cx * 3 + b.cz)) * 0.3);
    const eaveForWindows = windowsAllowed(osmType, b.eave) ? b.eave : 0;

    for (let i = b.s; i < b.s + b.n; i++) {
      pos[i * 3] = qPos[i * 3] / 10;
      pos[i * 3 + 1] = qPos[i * 3 + 1] / 10 + yShift;
      pos[i * 3 + 2] = qPos[i * 3 + 2] / 10;
      const isWall = qFlag[i];
      const c = isWall ? wallC : roofC;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      win[i * 2] = qWin[i * 2] / 10;
      win[i * 2 + 1] = qWin[i * 2 + 1] / 10;
      extra[i * 4] = seed;
      extra[i * 4 + 1] = isWall;
      extra[i * 4 + 2] = flood * (isWall ? 1 : 0.7);
      extra[i * 4 + 3] = eaveForWindows;
    }
  }

  // corrupt source surfaces (2D posLists, parser slips) yield triangles spanning
  // hundreds of meters — collapse anything with an implausibly long edge
  let dropped = 0;
  const MAX_EDGE_SQ = 220 * 220;
  for (let t = 0; t < n; t += 3) {
    let bad = false;
    for (let k = 0; k < 3 && !bad; k++) {
      const a = (t + k) * 3;
      const b = (t + ((k + 1) % 3)) * 3;
      const dx = pos[a] - pos[b];
      const dy = pos[a + 1] - pos[b + 1];
      const dz = pos[a + 2] - pos[b + 2];
      if (dx * dx + dy * dy + dz * dz > MAX_EDGE_SQ) bad = true;
    }
    if (bad) {
      for (let k = 1; k < 3; k++) {
        pos[(t + k) * 3] = pos[t * 3];
        pos[(t + k) * 3 + 1] = pos[t * 3 + 1];
        pos[(t + k) * 3 + 2] = pos[t * 3 + 2];
      }
      dropped++;
    }
  }
  if (dropped) console.info(`[lod2] ${dropped} fehlerhafte Riesen-Dreiecke entfernt`);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aWin', new THREE.BufferAttribute(win, 2));
  geo.setAttribute('aExtra', new THREE.BufferAttribute(extra, 4));
  geo.computeVertexNormals();

  // Quantization collapses some sliver triangles to zero area; their normals
  // become NaN and a single NaN poisons the whole GTAO/bloom framebuffer.
  const nor = geo.attributes.normal.array;
  let repaired = 0;
  for (let i = 0; i < nor.length; i += 3) {
    if (!Number.isFinite(nor[i]) || !Number.isFinite(nor[i + 1]) || !Number.isFinite(nor[i + 2])) {
      nor[i] = 0;
      nor[i + 1] = 1;
      nor[i + 2] = 0;
      repaired++;
    }
  }
  if (repaired) console.info(`[lod2] ${repaired} degenerierte Normalen repariert`);

  // surveyed surfaces have mixed winding after triangulation — render both sides
  const mesh = new THREE.Mesh(geo, createBuildingMaterial(THREE.DoubleSide));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings-lod2';
  console.info(
    `[lod2] ${meta.buildings.length} amtliche Gebäudemodelle geladen, ${stoneCount} als Kirche/Turm/Burg erkannt` +
      (bridgeSkips ? `, ${bridgeSkips} Brückenbauwerke übersprungen` : '')
  );
  return { mesh, count: meta.buildings.length };
}

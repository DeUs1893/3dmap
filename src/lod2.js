// Loader for the baked Bavarian LoD2 building models (tools/bake-lod2.mjs).
// If public/data/lod2.bin exists, these surveyed models (real roof shapes)
// replace the extruded OSM buildings. Shares the OSM building material so
// windows, floodlight and facade detail keep working.
import * as THREE from 'three';
import { LANDMARKS } from './config.js';
import { project, hash01 } from './geo.js';
import { groundY } from './terrain.js';
import { createBuildingMaterial } from './buildings.js';

const WALL_PALETTE = [0xc9b896, 0xbfae90, 0xd2c2a4, 0xb3a288, 0xc4ad9d, 0xa9ab97, 0xcbb6a8, 0xbdb09a].map(
  (c) => new THREE.Color(c)
);
const ROOF_PALETTE = [0x9a5743, 0x8d4f3d, 0xa05f48, 0x86503f].map((c) => new THREE.Color(c));

export async function loadLOD2(baseUrl = '') {
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
  const tmp = new THREE.Color();

  for (const b of meta.buildings) {
    const seed = hash01(Math.round(b.cx * 7 + b.cz * 13));
    // align the surveyed base height with our terrain
    const yShift = groundY(b.cx, b.cz) - b.minH - 0.4;
    let flood = 0;
    for (const lm of landmarkPts) {
      const d = Math.hypot(b.cx - lm.x, b.cz - lm.z);
      if (d < lm.r) flood = Math.max(flood, 1 - (d / lm.r) * 0.5);
    }
    const wallC = tmp
      .copy(WALL_PALETTE[Math.floor(seed * WALL_PALETTE.length)])
      .multiplyScalar(0.85 + hash01(Math.round(b.cx * 31)) * 0.3)
      .clone();
    const roofC = ROOF_PALETTE[Math.floor(hash01(Math.round(b.cz * 17)) * ROOF_PALETTE.length)]
      .clone()
      .multiplyScalar(0.85 + hash01(Math.round(b.cx * 3 + b.cz)) * 0.3);

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
      extra[i * 4 + 3] = b.eave;
    }
  }

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
  console.info(`[lod2] ${meta.buildings.length} amtliche Gebäudemodelle geladen`);
  return { mesh, count: meta.buildings.length };
}

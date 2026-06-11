import * as THREE from 'three';
import { MAP_BBOX, TERRAIN_MARGIN, BASE_ELEVATION } from './config.js';
import { project, unproject } from './geo.js';

let meta = null;
let grid = null;

function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

export async function loadTerrainData(baseUrl = '') {
  const [metaRes, binRes] = await Promise.all([
    fetch(`${baseUrl}data/terrain.json`),
    fetch(`${baseUrl}data/terrain.bin`),
  ]);
  if (!metaRes.ok || !binRes.ok) throw new Error('Geländedaten konnten nicht geladen werden');
  meta = await metaRes.json();
  grid = new Uint16Array(await binRes.arrayBuffer());
}

// Elevation in meters above sea level, bilinear-filtered
export function sampleElevation(lon, lat) {
  const fx = (lonToTileX(lon, meta.zoom) - meta.tileXMin) * 256;
  const fy = (latToTileY(lat, meta.zoom) - meta.tileYMin) * 256;
  const x0 = Math.max(0, Math.min(meta.width - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(meta.height - 2, Math.floor(fy)));
  const ax = Math.max(0, Math.min(1, fx - x0));
  const ay = Math.max(0, Math.min(1, fy - y0));
  const w = meta.width;
  const v00 = grid[y0 * w + x0];
  const v10 = grid[y0 * w + x0 + 1];
  const v01 = grid[(y0 + 1) * w + x0];
  const v11 = grid[(y0 + 1) * w + x0 + 1];
  return ((v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay) / 10;
}

// Scene-space ground height (y) at local x/z
export function groundY(x, z) {
  const { lon, lat } = unproject(x, z);
  return sampleElevation(lon, lat) - BASE_ELEVATION;
}

/**
 * Builds the terrain mesh. waterMask(x, z) → waterLevelY | null lets the
 * caller sink the riverbed below the water surface.
 */
export function buildTerrainMesh(waterMask = null) {
  const sw = project(MAP_BBOX.west, MAP_BBOX.south);
  const ne = project(MAP_BBOX.east, MAP_BBOX.north);
  const minX = Math.min(sw.x, ne.x) - TERRAIN_MARGIN;
  const maxX = Math.max(sw.x, ne.x) + TERRAIN_MARGIN;
  const minZ = Math.min(sw.z, ne.z) - TERRAIN_MARGIN;
  const maxZ = Math.max(sw.z, ne.z) + TERRAIN_MARGIN;
  const sizeX = maxX - minX;
  const sizeZ = maxZ - minZ;

  const step = 9; // meters per vertex
  const segX = Math.min(640, Math.round(sizeX / step));
  const segZ = Math.min(640, Math.round(sizeZ / step));

  const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ);
  geo.rotateX(-Math.PI / 2); // plane in xz, +y up
  geo.translate(minX + sizeX / 2, 0, minZ + sizeZ / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cValley = new THREE.Color(0x2a3026);
  const cHill = new THREE.Color(0x3a4231);
  const cRock = new THREE.Color(0x46413a);
  const cBed = new THREE.Color(0x141d22);
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    let y = groundY(x, z);
    let isBed = false;
    if (waterMask) {
      const wl = waterMask(x, z);
      if (wl !== null && y > wl - 2.5) {
        y = wl - 2.5;
        isBed = true;
      }
    }
    pos.setY(i, y);
    const t = THREE.MathUtils.clamp((y - 0) / 170, 0, 1);
    tmp.copy(cValley).lerp(cHill, t);
    if (t > 0.55) tmp.lerp(cRock, (t - 0.55) * 0.6);
    if (isBed) tmp.copy(cBed);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return { mesh, bounds: { minX, maxX, minZ, maxZ } };
}

import * as THREE from 'three';
import { LANDMARKS } from './config.js';
import { project, hash01 } from './geo.js';
import { groundY } from './terrain.js';
import { projectRing, ringArea, ringCentroid, triangulatePolygon } from './polyutil.js';

const WALL_PALETTE = [0xc9b896, 0xbfae90, 0xd2c2a4, 0xb3a288, 0xc4ad9d, 0xa9ab97, 0xcbb6a8, 0xbdb09a].map(
  (c) => new THREE.Color(c)
);
const ROOF_PALETTE = [0x9a5743, 0x8d4f3d, 0xa05f48, 0x86503f].map((c) => new THREE.Color(c));
const STONE = new THREE.Color(0xb6a890);
const STONE_ROOF = new THREE.Color(0x6f6a60);

function isStone(type) {
  return type === 'church' || type === 'cathedral' || type === 'chapel' || type === 'castle';
}

// Per-building floodlight factor from landmark proximity
function floodFactor(centroid) {
  let f = 0;
  for (const lm of LANDMARKS) {
    const p = project(lm.lon, lm.lat);
    const d = Math.hypot(centroid.x - p.x, centroid.y - p.z);
    if (d < lm.floodRadius) f = Math.max(f, 1 - (d / lm.floodRadius) * 0.5);
  }
  return f;
}

export const buildingUniforms = {
  u_windowGlow: { value: 1.6 },
  u_litRatio: { value: 0.55 },
  u_floodGlow: { value: 0.55 },
};

export function createBuildingMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.02,
    flatShading: true,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, buildingUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aWin;
        attribute vec4 aExtra;
        varying vec2 vWin;
        varying vec4 vExtra;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWin = aWin;
        vExtra = aExtra;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float u_windowGlow;
        uniform float u_litRatio;
        uniform float u_floodGlow;
        varying vec2 vWin;
        varying vec4 vExtra;
        float winHash(vec2 cell, float seed) {
          return fract(sin(dot(cell + seed * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float isWall = vExtra.y;
          float bHeight = vExtra.w;
          vec2 grid = vec2(2.7, 3.1);
          vec2 local = vWin - vec2(0.0, 0.9);
          vec2 cell = floor(local / grid);
          vec2 cuv = fract(local / grid);
          float inWin = step(0.24, cuv.x) * step(cuv.x, 0.76) * step(0.28, cuv.y) * step(cuv.y, 0.78);
          float validRow = step(0.9, vWin.y) * step(vWin.y, bHeight - 0.8);
          float h = winHash(cell, vExtra.x);
          float lit = step(1.0 - u_litRatio, h);
          float coolMix = step(0.92, fract(h * 13.0));
          vec3 winCol = mix(vec3(1.0, 0.62, 0.30), vec3(0.72, 0.80, 1.0), coolMix);
          float flicker = 0.85 + 0.15 * fract(h * 31.0);
          totalEmissiveRadiance += winCol * (inWin * lit * validRow * isWall * flicker) * u_windowGlow;
          float falloff = mix(0.4, exp(-max(vWin.y, 0.0) * 0.06), isWall);
          totalEmissiveRadiance += vec3(1.0, 0.74, 0.42) * vExtra.z * falloff * u_floodGlow;
        }`
      );
    mat.userData.shader = shader;
  };
  return mat;
}

/**
 * Builds one merged mesh for all buildings.
 * Attributes: position, normal, color, aWin (u along wall, v above base), aExtra (seed, isWall, flood, height)
 */
export async function buildBuildings(buildings, onProgress = () => {}) {
  const pos = [];
  const col = [];
  const win = [];
  const extra = [];

  const tmpColor = new THREE.Color();

  const pushTri = (ax, ay, az, bx, by, bz, cx, cy, cz, c, uvs, seed, isWall, flood, height) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
    win.push(uvs[0], uvs[1], uvs[2], uvs[3], uvs[4], uvs[5]);
    for (let k = 0; k < 3; k++) extra.push(seed, isWall, flood, height);
  };

  let processed = 0;
  for (const b of buildings) {
    processed++;
    if (processed % 800 === 0) {
      onProgress(processed / buildings.length);
      await new Promise((r) => requestAnimationFrame(r));
    }

    const outer = projectRing(b.outer);
    if (outer.length < 3) continue;
    const area = Math.abs(ringArea(outer));
    if (area < 4) continue;
    const holes = b.holes.map(projectRing).filter((h) => h.length >= 3);

    // base/top elevation from terrain under the footprint
    let base = Infinity;
    for (const p of outer) base = Math.min(base, groundY(p.x, p.y));
    if (!Number.isFinite(base)) continue;
    const height = Math.max(3, b.height);
    const top = base + height;
    const skirt = base - 6; // walls extend below ground on slopes

    const seed = hash01(b.id);
    const stone = isStone(b.type);
    const centroid = ringCentroid(outer);
    const flood = floodFactor(centroid);

    const wallC = tmpColor
      .copy(stone ? STONE : WALL_PALETTE[Math.floor(seed * WALL_PALETTE.length)])
      .clone()
      .multiplyScalar(0.85 + hash01(b.id + 7) * 0.3);
    const roofC = (stone ? STONE_ROOF : ROOF_PALETTE[Math.floor(hash01(b.id + 13) * ROOF_PALETTE.length)])
      .clone()
      .multiplyScalar(0.85 + hash01(b.id + 31) * 0.3);

    // --- walls ---
    // In (x, z) with z = south, outward-facing walls need the outer ring clockwise
    // (negative ringArea); holes the opposite.
    const rings = [ringArea(outer) > 0 ? outer.slice().reverse() : outer].concat(
      holes.map((h) => (ringArea(h) < 0 ? h.slice().reverse() : h))
    );
    for (const ring of rings) {
      let u = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const c = ring[(i + 1) % ring.length];
        const segLen = a.distanceTo(c);
        if (segLen < 0.01) continue;
        const u2 = u + segLen;
        // two triangles: (a,skirt)-(c,skirt)-(c,top) and (a,skirt)-(c,top)-(a,top)
        pushTri(a.x, skirt, a.y, c.x, skirt, c.y, c.x, top, c.y, wallC, [u, skirt - base, u2, skirt - base, u2, height], seed, 1, flood, height);
        pushTri(a.x, skirt, a.y, c.x, top, c.y, a.x, top, a.y, wallC, [u, skirt - base, u2, height, u, height], seed, 1, flood, height);
        u = u2;
      }
    }

    // --- roof ---
    const tri = triangulatePolygon(outer, holes);
    if (tri) {
      for (const [i, j, k] of tri.triangles) {
        const p1 = tri.points[i];
        const p2 = tri.points[j];
        const p3 = tri.points[k];
        // ensure upward-facing winding (y-up, ring in xz with z = south)
        const cross = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
        const [q2, q3] = cross > 0 ? [p3, p2] : [p2, p3];
        pushTri(p1.x, top, p1.y, q2.x, top, q2.y, q3.x, top, q3.y, roofC, [0, 0, 0, 0, 0, 0], seed, 0, flood * 0.7, height);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aWin', new THREE.Float32BufferAttribute(win, 2));
  geo.setAttribute('aExtra', new THREE.Float32BufferAttribute(extra, 4));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, createBuildingMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  onProgress(1);
  return mesh;
}

import * as THREE from 'three';
import { LANDMARKS } from './config.js';
import { project, hash01 } from './geo.js';
import { groundY } from './terrain.js';
import {
  projectRing,
  ringArea,
  ringCentroid,
  triangulatePolygon,
  subdivideTriangles,
} from './polyutil.js';

const WALL_PALETTE = [0xc9b896, 0xbfae90, 0xd2c2a4, 0xb3a288, 0xc4ad9d, 0xa9ab97, 0xcbb6a8, 0xbdb09a].map(
  (c) => new THREE.Color(c)
);
const ROOF_PALETTE = [0x9a5743, 0x8d4f3d, 0xa05f48, 0x86503f].map((c) => new THREE.Color(c));
const STONE = new THREE.Color(0xb6a890);
const STONE_ROOF = new THREE.Color(0x6f6a60);
const COPPER = new THREE.Color(0x4e7d6e); // patinated church roofs/domes

function isStone(type) {
  return (
    type === 'church' || type === 'cathedral' || type === 'chapel' ||
    type === 'castle' || type === 'tower' || type === 'palace' || type === 'monastery'
  );
}

// OSM colour tags: hex with/without '#', or CSS colour names
function colorFromTag(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  try {
    if (/^#?[0-9a-f]{6}$/.test(v)) return new THREE.Color(v.startsWith('#') ? v : `#${v}`);
    if (/^[a-z]+$/.test(v)) {
      const c = new THREE.Color();
      // Color.setStyle warns on unknown names and leaves the color untouched
      const marker = c.getHex();
      c.setStyle(v);
      if (c.getHex() !== marker || v === 'white') return c;
    }
  } catch {
    /* unparseable tag */
  }
  return null;
}

// Pure CSS colors ("red", "blue") look like toy bricks — pull mapped colours
// toward architectural saturation/lightness without losing the hue.
function tameColor(c) {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(
    hsl.h,
    Math.min(hsl.s, 0.32),
    THREE.MathUtils.clamp(hsl.l, 0.28, 0.62)
  );
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
  u_windowGlow: { value: 1.05 },
  u_litRatio: { value: 0.45 },
  u_floodGlow: { value: 0.3 },
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
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float wall = vExtra.y;
          // grounded base, storey ledges and plaster grain keep facades from looking sterile
          float baseShade = 0.74 + 0.26 * smoothstep(0.0, 5.5, vWin.y);
          float fy = fract((vWin.y - 0.9) / 3.1);
          float ledge = 1.0 - 0.08 * smoothstep(0.08, 0.0, min(fy, 1.0 - fy));
          float grain = 0.95 + 0.10 * winHash(floor(vWin * vec2(0.9, 1.6)), vExtra.x + 5.0);
          diffuseColor.rgb *= mix(1.0, baseShade * ledge * grain, wall);
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float isWall = vExtra.y;
          float eaveH = vExtra.w;
          vec2 grid = vec2(2.7, 3.1);
          vec2 local = vWin - vec2(0.0, 0.9);
          vec2 cell = floor(local / grid);
          vec2 cuv = fract(local / grid);
          float inWin = step(0.24, cuv.x) * step(cuv.x, 0.76) * step(0.28, cuv.y) * step(cuv.y, 0.78);
          float validRow = step(0.9, vWin.y) * step(vWin.y, eaveH - 0.8);
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

// ---------------------------------------------------------------------------
// Roof shapes
// ---------------------------------------------------------------------------

// Oriented bounding box via the footprint's principal axis
function orientedBox(ring) {
  let cx = 0;
  let cy = 0;
  for (const p of ring) {
    cx += p.x;
    cy += p.y;
  }
  cx /= ring.length;
  cy /= ring.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of ring) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let axis = new THREE.Vector2(Math.cos(theta), Math.sin(theta));
  let perp = new THREE.Vector2(-axis.y, axis.x);
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const p of ring) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const a = dx * axis.x + dy * axis.y;
    const b = dx * perp.x + dy * perp.y;
    minA = Math.min(minA, a); maxA = Math.max(maxA, a);
    minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  }
  if (maxA - minA < maxB - minB) {
    [axis, perp] = [perp, axis];
    [minA, minB] = [minB, minA];
    [maxA, maxB] = [maxB, maxA];
  }
  const c = new THREE.Vector2(
    cx + axis.x * (minA + maxA) / 2 + perp.x * (minB + maxB) / 2,
    cy + axis.y * (minA + maxA) / 2 + perp.y * (minB + maxB) / 2
  );
  return {
    c,
    axis,
    perp,
    halfLen: Math.max(0.5, (maxA - minA) / 2),
    halfWidth: Math.max(0.5, (maxB - minB) / 2),
  };
}

const GABLE_DEFAULT_TYPES = new Set([
  'yes', 'house', 'detached', 'semidetached_house', 'terrace', 'residential', 'apartments',
]);

// Hip roof over arbitrary footprints (incl. courtyards): height rises with the
// distance to the nearest footprint edge — a cheap straight-skeleton stand-in.
function edgeDistanceFn(outer, holes) {
  const edges = [];
  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i++) {
      edges.push([ring[i], ring[(i + 1) % ring.length]]);
    }
  }
  return (p) => {
    let min = Infinity;
    for (const [a, b] of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy || 1e-9;
      const t = THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq, 0, 1);
      const ex = a.x + dx * t - p.x;
      const ey = a.y + dy * t - p.y;
      const d = ex * ex + ey * ey;
      if (d < min) min = d;
    }
    return Math.sqrt(min);
  };
}

function resolveRoof(b, outer, holes, ctx) {
  let shape = b.roof?.shape ?? null;
  if (shape === 'flat') return null;
  const area = Math.abs(ringArea(outer));
  if (!shape) {
    // German old towns are gabled by default; keep big/complex footprints flat
    const gableOk =
      holes.length === 0 &&
      outer.length <= 12 &&
      area < 700 &&
      (b.minHeight ?? 0) === 0 &&
      GABLE_DEFAULT_TYPES.has(b.type);
    // large historic/landmark buildings (Residenz & Co.) get hip/mansard roofs
    const hipOk =
      !gableOk &&
      area > 600 &&
      (b.minHeight ?? 0) === 0 &&
      (ctx.stone || ctx.flood > 0.25) &&
      b.height > 9;
    if (gableOk) shape = 'gabled';
    else if (hipOk) shape = 'hip-edge';
    else return null;
  }

  // courtyard footprints can't use the box-based shapes — fall back to edge distance
  if (holes.length > 0 && (shape === 'hipped' || shape === 'gabled' || shape === 'mansard')) {
    shape = 'hip-edge';
  }
  if (shape === 'hip-edge') {
    const obb = orientedBox(outer);
    const run = Math.min(obb.halfWidth, 9);
    const roofH = b.roof?.height ?? Math.min(5.5, run * 0.7);
    const dist = edgeDistanceFn(outer, holes);
    return {
      shape,
      height: roofH,
      maxEdge: 4,
      t: (p) => THREE.MathUtils.clamp(dist(p) / run, 0, 1),
      isDome: false,
    };
  }
  const obb = orientedBox(outer);
  const defaultH = {
    gabled: Math.min(4.5, obb.halfWidth * 0.8),
    hipped: Math.min(4.5, obb.halfWidth * 0.8),
    pyramidal: Math.min(8, obb.halfWidth * 1.1),
    dome: obb.halfWidth * 0.9,
    onion: obb.halfWidth * 1.1,
    skillion: Math.min(3, obb.halfWidth * 0.4),
    gambrel: Math.min(5, obb.halfWidth * 0.9),
    round: Math.min(4, obb.halfWidth * 0.7),
  };
  const roofH = b.roof?.height ?? defaultH[shape] ?? Math.min(4, obb.halfWidth * 0.7);
  if (!(roofH > 0.3)) return null;

  const { c, axis, perp, halfLen, halfWidth } = obb;
  const axDist = (p) => Math.abs((p.x - c.x) * axis.x + (p.y - c.y) * axis.y);
  const perpDist = (p) => Math.abs((p.x - c.x) * perp.x + (p.y - c.y) * perp.y);
  let tFn;
  switch (shape) {
    case 'hipped': {
      const ridgeHalf = Math.max(0, halfLen - halfWidth);
      tFn = (p) => 1 - Math.hypot(Math.max(0, axDist(p) - ridgeHalf), perpDist(p)) / halfWidth;
      break;
    }
    case 'pyramidal':
      tFn = (p) => 1 - Math.max(axDist(p) / halfLen, perpDist(p) / halfWidth);
      break;
    case 'dome':
    case 'onion':
    case 'round': {
      tFn = (p) => {
        const r = Math.max(axDist(p) / halfLen, perpDist(p) / halfWidth);
        return Math.sqrt(Math.max(0, 1 - r * r));
      };
      break;
    }
    case 'skillion':
      tFn = (p) => (((p.x - c.x) * perp.x + (p.y - c.y) * perp.y) / halfWidth + 1) / 2;
      break;
    case 'gambrel':
    case 'gabled':
    default:
      tFn = (p) => 1 - perpDist(p) / halfWidth;
      break;
  }
  const isDome = shape === 'dome' || shape === 'onion' || shape === 'round';
  return {
    shape,
    height: roofH,
    maxEdge: THREE.MathUtils.clamp(halfWidth / (isDome ? 4 : 2.5), 2, 10),
    t: (p) => THREE.MathUtils.clamp(tFn(p), 0, 1),
    isDome,
  };
}

/**
 * Builds one merged mesh for buildings and building parts.
 * Attributes: position, normal, color, aWin (u along wall, v above base),
 * aExtra (seed, isWall, flood, eave height above base)
 */
export async function buildBuildings(buildings, onProgress = () => {}) {
  const pos = [];
  const col = [];
  const win = [];
  const extra = [];

  const pushTri = (ax, ay, az, bx, by, bz, cx, cy, cz, c, uvs, seed, isWall, flood, eaveH) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
    win.push(uvs[0], uvs[1], uvs[2], uvs[3], uvs[4], uvs[5]);
    for (let k = 0; k < 3; k++) extra.push(seed, isWall, flood, eaveH);
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
    let ground = Infinity;
    let crest = -Infinity;
    for (const p of outer) {
      const g = groundY(p.x, p.y);
      ground = Math.min(ground, g);
      crest = Math.max(crest, g);
    }
    if (!Number.isFinite(ground)) continue;
    const minHeight = b.minHeight ?? 0;
    const height = Math.max(3, b.height);
    // on steep slopes keep the uphill side visible too
    const top = Math.max(ground + height, crest + Math.min(height, 10));
    const baseY = ground + minHeight;
    const bottom = minHeight > 0 ? baseY : ground - 6; // skirt into slopes

    const seed = hash01(b.id);
    const stone = isStone(b.type);
    const centroid = ringCentroid(outer);
    const flood = floodFactor(centroid);

    const roof = resolveRoof(b, outer, holes, { stone, flood });
    const roofH = roof ? Math.min(roof.height, (top - baseY) * 0.7) : 0;
    const eave = top - roofH;
    const eaveH = eave - baseY;
    const roofYAt = roof ? (p) => eave + roofH * roof.t(p) : () => top;

    const taggedWall = colorFromTag(b.wallColor);
    if (taggedWall) tameColor(taggedWall);
    const taggedRoof = colorFromTag(b.roofColor);
    if (taggedRoof) tameColor(taggedRoof);
    const wallC = (taggedWall ?? (stone ? STONE : WALL_PALETTE[Math.floor(seed * WALL_PALETTE.length)]))
      .clone()
      .multiplyScalar(taggedWall ? 0.95 + hash01(b.id + 7) * 0.1 : 0.85 + hash01(b.id + 7) * 0.3);
    const roofC = (taggedRoof ?? (stone
      ? roof?.isDome ? COPPER : STONE_ROOF
      : ROOF_PALETTE[Math.floor(hash01(b.id + 13) * ROOF_PALETTE.length)]
    ))
      .clone()
      .multiplyScalar(taggedRoof ? 0.95 + hash01(b.id + 31) * 0.1 : 0.85 + hash01(b.id + 31) * 0.3);

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
        const topA = roofYAt(a);
        const topC = roofYAt(c);
        pushTri(a.x, bottom, a.y, c.x, bottom, c.y, c.x, topC, c.y, wallC, [u, bottom - baseY, u2, bottom - baseY, u2, topC - baseY], seed, 1, flood, eaveH);
        pushTri(a.x, bottom, a.y, c.x, topC, c.y, a.x, topA, a.y, wallC, [u, bottom - baseY, u2, topC - baseY, u, topA - baseY], seed, 1, flood, eaveH);
        u = u2;
      }
    }

    // --- roof cap ---
    const tri = triangulatePolygon(outer, holes);
    if (tri) {
      let verts = tri.points;
      let tris = tri.triangles;
      if (roof) {
        ({ verts, tris } = subdivideTriangles(verts, tris, roof.maxEdge));
      }
      for (const [i, j, k] of tris) {
        const p1 = verts[i];
        const p2 = verts[j];
        const p3 = verts[k];
        // ensure upward-facing winding (y-up, ring in xz with z = south)
        const cross = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
        const [q2, q3] = cross > 0 ? [p3, p2] : [p2, p3];
        pushTri(
          p1.x, roofYAt(p1), p1.y,
          q2.x, roofYAt(q2), q2.y,
          q3.x, roofYAt(q3), q3.y,
          roofC, [0, 0, 0, 0, 0, 0], seed, 0, flood * 0.7, eaveH
        );
      }
      // floating parts get a bottom cap (visible from below)
      if (minHeight > 0) {
        for (const [i, j, k] of tri.triangles) {
          const p1 = tri.points[i];
          const p2 = tri.points[j];
          const p3 = tri.points[k];
          const cross = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
          const [q2, q3] = cross > 0 ? [p2, p3] : [p3, p2]; // downward
          pushTri(p1.x, baseY, p1.y, q2.x, baseY, q2.y, q3.x, baseY, q3.y, wallC, [0, 0, 0, 0, 0, 0], seed, 0, flood * 0.5, eaveH);
        }
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

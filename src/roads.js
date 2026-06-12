import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getMapRect } from './geo.js';
import { groundY } from './terrain.js';
import { projectRing, densifyPath, clipPathToRect } from './polyutil.js';

const ROAD_COLORS = {
  0: new THREE.Color(0x575b63),
  1: new THREE.Color(0x53575f),
  2: new THREE.Color(0x4d5159),
  3: new THREE.Color(0x46494f),
  4: new THREE.Color(0x5e574a), // pedestrian: warm cobblestone
  5: new THREE.Color(0x3d4046),
  6: new THREE.Color(0x4a463c), // paths: gravel
};
const BRIDGE_SIDE = new THREE.Color(0x5a5247);
const PARAPET = new THREE.Color(0x6e6557);
const PIER = new THREE.Color(0x55503f);
const RAIL_COLOR = new THREE.Color(0x2e2f33);

// Asphalt grain, dashed center lines on major roads, edge lines and a light
// curb seam - driven by aRoad = (meters along road, -1..1 across, rank).
function createRoadMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aRoad;
        varying vec3 vRoad;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRoad = aRoad;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vRoad;
        float roadHash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float rank = vRoad.z;
          float u = vRoad.x;
          float v = vRoad.y;
          if (rank < 6.5) {
            // asphalt / cobble grain
            float grain = 0.92 + 0.16 * roadHash(floor(vec2(u * 1.6, v * 5.0)));
            diffuseColor.rgb *= grain;
            // fine speckle for first-person range, fades with distance
            float nearF = 1.0 - smoothstep(30.0, 160.0, length(vViewPosition));
            if (nearF > 0.01) {
              float fine = roadHash(floor(vec2(u * 7.0, v * 26.0)) + 3.0);
              diffuseColor.rgb *= 1.0 + (fine - 0.5) * 0.15 * nearF;
            }
            // cobble pattern in pedestrian zones
            if (rank > 3.5 && rank < 4.5) {
              float cobble = 0.93 + 0.14 * roadHash(floor(vec2(u * 2.4, v * 8.0)) + 31.0);
              diffuseColor.rgb *= cobble;
            }
            // dashed center line on driving roads
            if (rank < 2.5) {
              float dash = step(fract(u / 9.0), 0.55);
              float line = (1.0 - smoothstep(0.025, 0.06, abs(v))) * dash;
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.72, 0.66), line * 0.8);
            }
            // solid edge lines on primaries
            if (rank < 1.5) {
              float edge = 1.0 - smoothstep(0.02, 0.05, abs(abs(v) - 0.8));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.62, 0.58), edge * 0.55);
            }
            // light curb seam
            float curb = smoothstep(0.9, 0.985, abs(v));
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.45 + vec3(0.025), curb * 0.65);
          }
        }`
      );
  };
  return mat;
}

/**
 * Computes deck heights for a densified path. Bridges span level between
 * their abutments with a slight arch; normal roads follow the terrain.
 */
function pathHeights(pts, road) {
  const ys = new Array(pts.length);
  if (road.bridge && pts.length >= 2) {
    const y0 = groundY(pts[0].x, pts[0].y) + 0.4;
    const y1 = groundY(pts[pts.length - 1].x, pts[pts.length - 1].y) + 0.4;
    const lengths = [0];
    for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = lengths[lengths.length - 1] || 1;
    for (let i = 0; i < pts.length; i++) {
      const t = lengths[i] / total;
      ys[i] = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * 1.6;
    }
  } else {
    for (let i = 0; i < pts.length; i++) ys[i] = groundY(pts[i].x, pts[i].y) + 0.55;
  }
  return ys;
}

function appendRibbon(arrays, pts, ys, width, color, withSkirts, rank = 7) {
  const { pos, col, idx, road } = arrays;
  const n = pts.length;
  if (n < 2) return;
  const half = width / 2;
  const start = pos.length / 3;

  let u = 0;
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let dx = next.x - prev.x;
    let dz = next.y - prev.y;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // perpendicular in xz
    const px = -dz;
    const pz = dx;
    if (i > 0) u += pts[i].distanceTo(pts[i - 1]);
    pos.push(pts[i].x + px * half, ys[i], pts[i].y + pz * half);
    pos.push(pts[i].x - px * half, ys[i], pts[i].y - pz * half);
    col.push(color.r, color.g, color.b, color.r, color.g, color.b);
    road.push(u, 1, rank, u, -1, rank);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = start + i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  if (withSkirts) {
    const depth = 3.2;
    const parapetH = 1.1;
    for (const side of [0, 1]) {
      // fascia below the deck
      let s0 = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const topIdx = (start + i * 2 + side) * 3;
        const x = pos[topIdx];
        const y = pos[topIdx + 1];
        const z = pos[topIdx + 2];
        pos.push(x, y, z, x, y - depth, z);
        col.push(BRIDGE_SIDE.r, BRIDGE_SIDE.g, BRIDGE_SIDE.b, BRIDGE_SIDE.r * 0.6, BRIDGE_SIDE.g * 0.6, BRIDGE_SIDE.b * 0.6);
        road.push(0, 0, 7, 0, 0, 7);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = s0 + i * 2;
        // double-sided via material; winding not critical
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      // stone parapet above the deck
      s0 = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const topIdx = (start + i * 2 + side) * 3;
        const x = pos[topIdx];
        const y = pos[topIdx + 1];
        const z = pos[topIdx + 2];
        pos.push(x, y, z, x, y + parapetH, z);
        col.push(PARAPET.r * 0.8, PARAPET.g * 0.8, PARAPET.b * 0.8, PARAPET.r, PARAPET.g, PARAPET.b);
        road.push(0, 0, 7, 0, 0, 7);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = s0 + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
}

// Stone piers from the deck down into the riverbed, every ~26 m
function appendPiers(arrays, pts, ys, width) {
  const { pos, col, idx, road } = arrays;
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = lengths[lengths.length - 1];
  if (total < 40) return;
  for (let s = 22; s < total - 18; s += 26) {
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < s) i++;
    const t = (s - lengths[i - 1]) / Math.max(0.001, lengths[i] - lengths[i - 1]);
    const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
    const z = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
    const deckY = ys[i - 1] + (ys[i] - ys[i - 1]) * t;
    let dx = pts[i].x - pts[i - 1].x;
    let dz = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const px = -dz;
    const pz = dx;
    const halfAlong = 1.7;
    const halfAcross = width * 0.42;
    const yTop = deckY - 0.3;
    const yBottom = Math.min(groundY(x, z), deckY - 4) - 2.5;
    // 4 corners: ±along, ±across
    const cs = [
      [x + dx * halfAlong + px * halfAcross, z + dz * halfAlong + pz * halfAcross],
      [x + dx * halfAlong - px * halfAcross, z + dz * halfAlong - pz * halfAcross],
      [x - dx * halfAlong - px * halfAcross, z - dz * halfAlong - pz * halfAcross],
      [x - dx * halfAlong + px * halfAcross, z - dz * halfAlong + pz * halfAcross],
    ];
    const s0 = pos.length / 3;
    for (const [cx, cz] of cs) {
      pos.push(cx, yTop, cz, cx, yBottom, cz);
      col.push(PIER.r, PIER.g, PIER.b, PIER.r * 0.55, PIER.g * 0.55, PIER.b * 0.55);
      road.push(0, 0, 7, 0, 0, 7);
    }
    for (let k = 0; k < 4; k++) {
      const a = s0 + k * 2;
      const b = s0 + ((k + 1) % 4) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

export function buildRoads(roads, rails) {
  const arrays = { pos: [], col: [], idx: [], road: [] };
  const trafficPaths = [];
  const tramPaths = [];
  const rect = getMapRect(450);

  const statueSpots = [];
  for (const road of roads) {
    if (road.tunnel) continue;
    for (const piece of clipPathToRect(projectRing(road.path), rect)) {
      const pts = densifyPath(piece, 9);
      if (pts.length < 2) continue;
      const ys = pathHeights(pts, road);
      const color = ROAD_COLORS[road.rank] ?? ROAD_COLORS[5];
      appendRibbon(arrays, pts, ys, road.width, color, road.bridge, road.rank);
      if (road.bridge) {
        appendPiers(arrays, pts, ys, road.width);
        if (road.name && /mainbr/i.test(road.name)) {
          collectStatueSpots(statueSpots, pts, ys, road.width);
        }
      }
      if (road.rank <= 2) trafficPaths.push({ pts, ys });
    }
  }

  for (const rail of rails) {
    for (const piece of clipPathToRect(projectRing(rail.path), rect)) {
      const pts = densifyPath(piece, 12);
      if (pts.length < 2) continue;
      const ys = pts.map((p) => groundY(p.x, p.y) + 0.5);
      appendRibbon(arrays, pts, ys, rail.tram ? 2.5 : 3.2, RAIL_COLOR, false, 8);
      if (rail.tram) tramPaths.push({ pts, ys });
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(arrays.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arrays.col, 3));
  geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(arrays.road, 3));
  geo.setIndex(arrays.idx);
  geo.computeVertexNormals();

  const mat = createRoadMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'roads';
  return { mesh, trafficPaths, tramPaths, statues: buildStatues(statueSpots) };
}

// The Alte Mainbrücke's twelve bridge saints, alternating sides every ~16 m
function collectStatueSpots(spots, pts, ys, width) {
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = lengths[lengths.length - 1];
  if (total < 60) return;
  let side = 1;
  for (let s = 18; s < total - 14; s += 16) {
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < s) i++;
    const t = (s - lengths[i - 1]) / Math.max(0.001, lengths[i] - lengths[i - 1]);
    const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
    const z = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
    const deckY = ys[i - 1] + (ys[i] - ys[i - 1]) * t;
    let dx = pts[i].x - pts[i - 1].x;
    let dz = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dz) || 1;
    spots.push({
      x: x + (-dz / len) * (width / 2 - 0.4) * side,
      z: z + (dx / len) * (width / 2 - 0.4) * side,
      y: deckY,
      rot: Math.atan2(dx, dz) + (side > 0 ? Math.PI : 0),
    });
    side = -side;
  }
}

function buildStatues(spots) {
  if (!spots.length) return null;
  const pedestal = new THREE.BoxGeometry(1.0, 2.6, 1.0).translate(0, 1.3, 0);
  const figure = new THREE.CapsuleGeometry(0.38, 1.5, 4, 8).translate(0, 3.7, 0);
  const geo = mergeGeometries([pedestal, figure]);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xa99d88,
    roughness: 0.9,
    metalness: 0,
    emissive: 0x1a1208,
    emissiveIntensity: 1,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    dummy.position.set(s.x, s.y, s.z);
    dummy.rotation.set(0, s.rot, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.castShadow = true;
  mesh.name = 'statues';
  return mesh;
}

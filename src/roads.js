import * as THREE from 'three';
import { getMapRect } from './geo.js';
import { groundY } from './terrain.js';
import { projectRing, densifyPath, clipPathToRect } from './polyutil.js';

const ROAD_COLORS = {
  0: new THREE.Color(0x4a4e57),
  1: new THREE.Color(0x474b54),
  2: new THREE.Color(0x42464e),
  3: new THREE.Color(0x3c4047),
  4: new THREE.Color(0x4d4a44), // pedestrian: warm cobblestone
  5: new THREE.Color(0x35383e),
  6: new THREE.Color(0x3b3a35),
};
const BRIDGE_SIDE = new THREE.Color(0x5a5247);
const RAIL_COLOR = new THREE.Color(0x2e2f33);

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

function appendRibbon(arrays, pts, ys, width, color, withSkirts) {
  const { pos, col, idx } = arrays;
  const n = pts.length;
  if (n < 2) return;
  const half = width / 2;
  const start = pos.length / 3;

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
    pos.push(pts[i].x + px * half, ys[i], pts[i].y + pz * half);
    pos.push(pts[i].x - px * half, ys[i], pts[i].y - pz * half);
    col.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = start + i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  if (withSkirts) {
    const depth = 3.2;
    for (const side of [0, 1]) {
      const s0 = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const topIdx = (start + i * 2 + side) * 3;
        const x = pos[topIdx];
        const y = pos[topIdx + 1];
        const z = pos[topIdx + 2];
        pos.push(x, y, z, x, y - depth, z);
        col.push(BRIDGE_SIDE.r, BRIDGE_SIDE.g, BRIDGE_SIDE.b, BRIDGE_SIDE.r * 0.6, BRIDGE_SIDE.g * 0.6, BRIDGE_SIDE.b * 0.6);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = s0 + i * 2;
        // double-sided via material; winding not critical
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
}

export function buildRoads(roads, rails) {
  const arrays = { pos: [], col: [], idx: [] };
  const trafficPaths = [];
  const rect = getMapRect(450);

  for (const road of roads) {
    if (road.tunnel) continue;
    for (const piece of clipPathToRect(projectRing(road.path), rect)) {
      const pts = densifyPath(piece, 9);
      if (pts.length < 2) continue;
      const ys = pathHeights(pts, road);
      const color = ROAD_COLORS[road.rank] ?? ROAD_COLORS[5];
      appendRibbon(arrays, pts, ys, road.width, color, road.bridge);

      if (road.rank <= 2) trafficPaths.push({ pts, ys });
    }
  }

  for (const rail of rails) {
    for (const piece of clipPathToRect(projectRing(rail.path), rect)) {
      const pts = densifyPath(piece, 12);
      if (pts.length < 2) continue;
      const ys = pts.map((p) => groundY(p.x, p.y) + 0.5);
      appendRibbon(arrays, pts, ys, rail.tram ? 2.5 : 3.2, RAIL_COLOR, false);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(arrays.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arrays.col, 3));
  geo.setIndex(arrays.idx);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'roads';
  return { mesh, trafficPaths };
}

import * as THREE from 'three';
import { project } from './geo.js';

// Projects a [lon,lat] ring to local Vector2 (x, z), dropping duplicate closing point
export function projectRing(ring) {
  const pts = [];
  const n = ring.length;
  const last = n - 1;
  const closed =
    Math.abs(ring[0][0] - ring[last][0]) < 1e-9 && Math.abs(ring[0][1] - ring[last][1]) < 1e-9;
  const end = closed ? last : n;
  for (let i = 0; i < end; i++) {
    const p = project(ring[i][0], ring[i][1]);
    pts.push(new THREE.Vector2(p.x, p.z));
  }
  return pts;
}

export function ringArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function ringCentroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return new THREE.Vector2(x / pts.length, y / pts.length);
}

export function pointInRing(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Triangulates outer ring + holes (local Vector2 arrays) into flat triangles.
 * Returns { positions: [x,z,...], indices } in 2D; caller assigns heights.
 */
export function triangulatePolygon(outer, holes = []) {
  if (outer.length < 3) return null;
  // ShapeUtils expects CCW outer and CW holes
  const o = ringArea(outer) < 0 ? outer.slice().reverse() : outer;
  const hs = holes
    .filter((h) => h.length >= 3)
    .map((h) => (ringArea(h) > 0 ? h.slice().reverse() : h));
  let tris;
  try {
    tris = THREE.ShapeUtils.triangulateShape(o, hs);
  } catch {
    return null;
  }
  const all = o.concat(...hs);
  return { points: all, triangles: tris };
}

/**
 * Subdivides triangles until no edge is longer than maxEdge (meters).
 * verts: THREE.Vector2[], tris: [i,j,k][]  → returns new {verts, tris}
 */
export function subdivideTriangles(verts, tris, maxEdge) {
  const v = verts.map((p) => p.clone());
  let t = tris.map((x) => x.slice());
  const maxSq = maxEdge * maxEdge;
  for (let pass = 0; pass < 8; pass++) {
    const out = [];
    const midCache = new Map();
    let split = false;
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let m = midCache.get(key);
      if (m === undefined) {
        m = v.length;
        v.push(new THREE.Vector2((v[a].x + v[b].x) / 2, (v[a].y + v[b].y) / 2));
        midCache.set(key, m);
      }
      return m;
    };
    for (const [a, b, c] of t) {
      const ab = v[a].distanceToSquared(v[b]);
      const bc = v[b].distanceToSquared(v[c]);
      const ca = v[c].distanceToSquared(v[a]);
      const longest = Math.max(ab, bc, ca);
      if (longest <= maxSq) {
        out.push([a, b, c]);
        continue;
      }
      split = true;
      if (longest === ab) {
        const m = midpoint(a, b);
        out.push([a, m, c], [m, b, c]);
      } else if (longest === bc) {
        const m = midpoint(b, c);
        out.push([b, m, a], [m, c, a]);
      } else {
        const m = midpoint(c, a);
        out.push([c, m, b], [m, a, b]);
      }
    }
    t = out;
    if (!split) break;
  }
  return { verts: v, tris: t };
}

// Sutherland–Hodgman clipping of a ring (THREE.Vector2[]) against a rectangle
export function clipRingToRect(ring, rect) {
  const edges = [
    (p) => p.x >= rect.minX,
    (p) => p.x <= rect.maxX,
    (p) => p.y >= rect.minZ,
    (p) => p.y <= rect.maxZ,
  ];
  const intersect = [
    (a, b) => new THREE.Vector2(rect.minX, a.y + ((b.y - a.y) * (rect.minX - a.x)) / (b.x - a.x)),
    (a, b) => new THREE.Vector2(rect.maxX, a.y + ((b.y - a.y) * (rect.maxX - a.x)) / (b.x - a.x)),
    (a, b) => new THREE.Vector2(a.x + ((b.x - a.x) * (rect.minZ - a.y)) / (b.y - a.y), rect.minZ),
    (a, b) => new THREE.Vector2(a.x + ((b.x - a.x) * (rect.maxZ - a.y)) / (b.y - a.y), rect.maxZ),
  ];
  let out = ring;
  for (let e = 0; e < 4; e++) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = edges[e](cur);
      const prevIn = edges[e](prev);
      if (curIn) {
        if (!prevIn) out.push(intersect[e](prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect[e](prev, cur));
      }
    }
    if (out.length < 3) return [];
  }
  return out;
}

// Splits a polyline into pieces inside the rectangle (clipping segments at the border)
export function clipPathToRect(path, rect) {
  const inside = (p) => p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minZ && p.y <= rect.maxZ;
  const pieces = [];
  let current = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (inside(p)) {
      if (current.length === 0 && i > 0) {
        // entering: add border intersection (approx: previous point clamped)
        const q = path[i - 1].clone();
        q.x = Math.max(rect.minX, Math.min(rect.maxX, q.x));
        q.y = Math.max(rect.minZ, Math.min(rect.maxZ, q.y));
        current.push(q);
      }
      current.push(p);
    } else if (current.length) {
      // leaving: clamp this point to the border as an endpoint
      const q = p.clone();
      q.x = Math.max(rect.minX, Math.min(rect.maxX, q.x));
      q.y = Math.max(rect.minZ, Math.min(rect.maxZ, q.y));
      current.push(q);
      if (current.length >= 2) pieces.push(current);
      current = [];
    }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

// Resamples a local-space polyline ([Vector2,...]) so points are at most `step` apart
export function densifyPath(pts, step) {
  if (pts.length < 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = a.distanceTo(b);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push(new THREE.Vector2().lerpVectors(a, b, k / n));
  }
  return out;
}

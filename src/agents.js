// Living city: a real road/footway graph plus instanced agents (cars and
// pedestrians) that travel it continuously — turning at junctions instead of
// despawning, u-turning at dead ends and map borders.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getMapRect } from './geo.js';
import { groundY } from './terrain.js';
import { projectRing, densifyPath, clipPathToRect } from './polyutil.js';
import { clampPointSize } from './lights.js';

// ---------------------------------------------------------------------------
// Graph: ways are split at shared vertices (OSM junctions share nodes)
// ---------------------------------------------------------------------------
export function buildTravelGraph(roads, rankFilter, step = 6) {
  const rect = getMapRect(420);
  const key = (p) => `${Math.round(p.x * 2)}_${Math.round(p.y * 2)}`;

  // collect clipped pieces and count vertex usage to find junctions
  const pieces = [];
  const usage = new Map();
  for (const road of roads) {
    if (road.tunnel || !rankFilter(road.rank)) continue;
    for (const piece of clipPathToRect(projectRing(road.path), rect)) {
      if (piece.length < 2) continue;
      pieces.push({ pts: piece, bridge: road.bridge, rank: road.rank });
      const seen = new Set();
      for (const p of piece) {
        const k = key(p);
        if (!seen.has(k)) {
          usage.set(k, (usage.get(k) ?? 0) + 1);
          seen.add(k);
        }
      }
    }
  }

  // split pieces at junction vertices, build edges with draped heights
  const nodes = new Map(); // key -> { edges: [] }
  const edges = [];
  const nodeAt = (p) => {
    const k = key(p);
    if (!nodes.has(k)) nodes.set(k, { edges: [] });
    return k;
  };
  const addEdge = (pts, bridge, rank) => {
    if (pts.length < 2) return;
    const dense = densifyPath(pts, step);
    const ys = new Array(dense.length);
    if (bridge) {
      const y0 = groundY(dense[0].x, dense[0].y) + 0.6;
      const y1 = groundY(dense[dense.length - 1].x, dense[dense.length - 1].y) + 0.6;
      for (let i = 0; i < dense.length; i++) {
        const t = i / (dense.length - 1);
        ys[i] = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * 1.6;
      }
    } else {
      for (let i = 0; i < dense.length; i++) ys[i] = groundY(dense[i].x, dense[i].y) + 0.6;
    }
    const cum = [0];
    for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + dense[i].distanceTo(dense[i - 1]));
    const len = cum[cum.length - 1];
    if (len < 4) return;
    const a = nodeAt(dense[0]);
    const b = nodeAt(dense[dense.length - 1]);
    const idx = edges.push({ a, b, pts: dense, ys, cum, len, rank }) - 1;
    nodes.get(a).edges.push(idx);
    nodes.get(b).edges.push(idx);
  };

  for (const piece of pieces) {
    let start = 0;
    for (let i = 1; i < piece.pts.length; i++) {
      const isEnd = i === piece.pts.length - 1;
      const isJunction = (usage.get(key(piece.pts[i])) ?? 0) >= 2;
      if (isEnd || isJunction) {
        addEdge(piece.pts.slice(start, i + 1), piece.bridge, piece.rank);
        start = i;
      }
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3(1, 1, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class AgentSystem {
  /**
   * opts: { count, speedMin, speedMax, yOffset, pauseChance, pauseMax,
   *         spawnWeight(edge) }
   */
  constructor(graph, mesh, opts) {
    this.graph = graph;
    this.mesh = mesh;
    this.opts = opts;
    this.agents = [];
    if (!graph.edges.length) {
      mesh.count = 0;
      return;
    }

    // weighted spawn distribution
    const weights = graph.edges.map((e) => (opts.spawnWeight?.(e) ?? 1) * e.len);
    const total = weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < opts.count; i++) {
      let r = Math.random() * total;
      let ei = 0;
      while (ei < weights.length - 1 && r > weights[ei]) {
        r -= weights[ei];
        ei++;
      }
      const edge = graph.edges[ei];
      this.agents.push({
        edge,
        s: Math.random() * edge.len,
        dir: Math.random() < 0.5 ? 1 : -1,
        speed: opts.speedMin + Math.random() * (opts.speedMax - opts.speedMin),
        yaw: 0,
        pause: 0,
        phase: Math.random() * Math.PI * 2,
      });
    }
    mesh.count = this.agents.length;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  /** continue onto a random connected edge; u-turn only at dead ends */
  advance(agent) {
    const nodeKey = agent.dir > 0 ? agent.edge.b : agent.edge.a;
    const node = this.graph.nodes.get(nodeKey);
    const options = node.edges.filter((ei) => this.graph.edges[ei] !== agent.edge);
    const next = options.length
      ? this.graph.edges[options[Math.floor(Math.random() * options.length)]]
      : agent.edge; // dead end → turn around
    agent.edge = next;
    if (next.a === nodeKey) {
      agent.dir = 1;
      agent.s = 0;
    } else {
      agent.dir = -1;
      agent.s = next.len;
    }
  }

  update(dt, time) {
    const { yOffset = 0, pauseChance = 0, pauseMax = 10, bob = 0 } = this.opts;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.pause > 0) {
        a.pause -= dt;
      } else {
        if (pauseChance && Math.random() < pauseChance * dt) a.pause = 2 + Math.random() * pauseMax;
        a.s += a.speed * a.dir * dt;
        if (a.s <= 0 || a.s >= a.edge.len) {
          a.s = THREE.MathUtils.clamp(a.s, 0, a.edge.len);
          this.advance(a);
        }
      }

      // sample position + heading on the edge
      const { pts, ys, cum } = a.edge;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= a.s) lo = mid;
        else hi = mid;
      }
      const t = (a.s - cum[lo]) / Math.max(0.001, cum[hi] - cum[lo]);
      const x = pts[lo].x + (pts[hi].x - pts[lo].x) * t;
      const z = pts[lo].y + (pts[hi].y - pts[lo].y) * t;
      const y = ys[lo] + (ys[hi] - ys[lo]) * t + yOffset;

      const targetYaw = Math.atan2(
        (pts[hi].x - pts[lo].x) * a.dir,
        (pts[hi].y - pts[lo].y) * a.dir
      );
      // shortest-arc yaw smoothing
      let d = targetYaw - a.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      a.yaw += d * Math.min(1, dt * 8);

      tmpPos.set(x, y + (bob ? Math.sin(time * 7 + a.phase) * bob * Math.min(1, a.speed) : 0), z);
      tmpQuat.setFromAxisAngle(Y_AXIS, a.yaw);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      this.mesh.setMatrixAt(i, tmpMatrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** world position + heading of agent i (for attached light sprites) */
  pose(i, out) {
    this.mesh.getMatrixAt(i, tmpMatrix);
    out.position.setFromMatrixPosition(tmpMatrix);
    out.yaw = this.agents[i].yaw;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------
const CAR_COLORS = [0xb8bcc2, 0x2e3338, 0x7a1f1f, 0x1f3a5e, 0x5b6157, 0xcfc7b0, 0x3c3c3c].map(
  (c) => new THREE.Color(c)
);
const CLOTHES = [0x4a5a78, 0x7a4a4a, 0x4a6b4f, 0x6e5a8a, 0x8a7340, 0x3d3d44, 0xa05f48, 0x47626e].map(
  (c) => new THREE.Color(c)
);

function paint(geo, color) {
  const c = new THREE.Color(color);
  const arr = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < geo.attributes.position.count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

export function buildCarMesh(count) {
  // simple sedan: body + darker cabin, +z is the driving direction
  const body = paint(new THREE.BoxGeometry(1.75, 0.55, 4.1).translate(0, 0.45, 0), 0xffffff);
  const cabin = paint(new THREE.BoxGeometry(1.55, 0.5, 2.0).translate(0, 0.95, -0.25), 0x1c2126);
  const geo = mergeGeometries([body, cabin]);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.45 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    c.copy(CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)])
      .multiplyScalar(0.85 + Math.random() * 0.3);
    mesh.setColorAt(i, c);
  }
  mesh.castShadow = true;
  mesh.name = 'cars';
  return mesh;
}

export function buildPersonMesh(count) {
  const bodyGeo = paint(new THREE.CapsuleGeometry(0.17, 0.62, 3, 8).translate(0, 0.92, 0), 0xffffff);
  const headGeo = paint(new THREE.SphereGeometry(0.115, 8, 6).translate(0, 1.55, 0), 0xd9b08c);
  const geo = mergeGeometries([bodyGeo, headGeo]);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    c.copy(CLOTHES[Math.floor(Math.random() * CLOTHES.length)])
      .multiplyScalar(0.8 + Math.random() * 0.45);
    mesh.setColorAt(i, c);
  }
  mesh.castShadow = true;
  mesh.name = 'people';
  return mesh;
}

/** white head- and red taillight sprites following the cars (night glow) */
export class CarLights {
  constructor(carSystem, texture) {
    this.cars = carSystem;
    const n = carSystem.agents.length;
    this.positions = new Float32Array(n * 2 * 3);
    const colors = new Float32Array(n * 2 * 3);
    const white = new THREE.Color(0xfff2cf);
    const red = new THREE.Color(0xff3b2e);
    for (let i = 0; i < n; i++) {
      colors.set([white.r, white.g, white.b], i * 6);
      colors.set([red.r, red.g, red.b], i * 6 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.points = new THREE.Points(
      geo,
      clampPointSize(new THREE.PointsMaterial({
        size: 2.6,
        map: texture,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }), 28)
    );
    this.points.frustumCulled = false;
    this.points.name = 'car-lights';
  }

  update() {
    const agents = this.cars.agents;
    for (let i = 0; i < agents.length; i++) {
      this.cars.mesh.getMatrixAt(i, tmpMatrix);
      tmpPos.setFromMatrixPosition(tmpMatrix);
      const yaw = agents[i].yaw;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      this.positions[i * 6] = tmpPos.x + fx * 2.1;
      this.positions[i * 6 + 1] = tmpPos.y + 0.55;
      this.positions[i * 6 + 2] = tmpPos.z + fz * 2.1;
      this.positions[i * 6 + 3] = tmpPos.x - fx * 2.1;
      this.positions[i * 6 + 4] = tmpPos.y + 0.6;
      this.positions[i * 6 + 5] = tmpPos.z - fz * 2.1;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

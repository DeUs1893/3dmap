import * as THREE from 'three';
import { getMapRect } from './geo.js';
import { groundY } from './terrain.js';
import { projectRing, densifyPath, clipPathToRect } from './polyutil.js';

// Soft round sprite used by lamps and car lights
export function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Street lamps as additive point sprites along roads */
export function buildLamps(roads, texture) {
  const positions = [];
  const colors = [];
  const warm = new THREE.Color(0xffc98a);
  const cool = new THREE.Color(0xcfe0ff);

  const rect = getMapRect(450);
  outer: for (const road of roads) {
    if (road.tunnel || road.rank > 4) continue;
    const spacing = road.rank <= 1 ? 32 : road.rank <= 3 ? 40 : 26;
    for (const piece of clipPathToRect(projectRing(road.path), rect)) {
      const pts = densifyPath(piece, spacing);
      // skip endpoints to reduce double lamps at junctions
      for (let i = 1; i < pts.length - 1; i++) {
        if (positions.length / 3 > 9000) break outer;
        const p = pts[i];
        const y = groundY(p.x, p.y) + (road.rank <= 1 ? 7 : 4.6);
        positions.push(p.x, y, p.y);
        const c = road.rank <= 1 && Math.random() < 0.5 ? cool : warm;
        colors.push(c.r, c.g, c.b);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 5.5,
    map: texture,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'lamps';
  points.frustumCulled = false;
  return points;
}

/** Animated car lights flowing along major roads */
export class TrafficSystem {
  constructor(trafficPaths, texture) {
    this.paths = trafficPaths
      .filter((p) => p.pts.length >= 2)
      .map((p) => {
        const cum = [0];
        for (let i = 1; i < p.pts.length; i++) {
          cum.push(cum[i - 1] + p.pts[i].distanceTo(p.pts[i - 1]));
        }
        return { ...p, cum, total: cum[cum.length - 1] };
      })
      .filter((p) => p.total > 60);

    const totalLen = this.paths.reduce((s, p) => s + p.total, 0);
    const count = Math.min(380, Math.max(40, Math.round(totalLen / 110)));
    this.cars = [];
    for (let i = 0; i < count; i++) {
      const path = this.paths[Math.floor(Math.random() * this.paths.length)];
      this.cars.push({
        path,
        s: Math.random() * path.total,
        dir: Math.random() < 0.5 ? 1 : -1,
        speed: 7 + Math.random() * 7,
      });
    }

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const white = new THREE.Color(0xfff4d6);
    const red = new THREE.Color(0xff5a3c);
    for (let i = 0; i < count; i++) {
      const c = this.cars[i].dir > 0 ? white : red;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 4,
        map: texture,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      })
    );
    this.points.name = 'traffic';
    this.points.frustumCulled = false;
  }

  update(dt) {
    if (!this.paths.length) return;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.s += car.speed * car.dir * dt;
      if (car.s < 0 || car.s > car.path.total) {
        // respawn on a random path
        car.path = this.paths[Math.floor(Math.random() * this.paths.length)];
        car.dir = Math.random() < 0.5 ? 1 : -1;
        car.s = car.dir > 0 ? 0 : car.path.total;
      }
      const { pts, ys, cum } = car.path;
      // binary search segment
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= car.s) lo = mid;
        else hi = mid;
      }
      const t = (car.s - cum[lo]) / Math.max(0.001, cum[hi] - cum[lo]);
      const x = pts[lo].x + (pts[hi].x - pts[lo].x) * t;
      const z = pts[lo].y + (pts[hi].y - pts[lo].y) * t;
      const y = ys[lo] + (ys[hi] - ys[lo]) * t + 0.8;
      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

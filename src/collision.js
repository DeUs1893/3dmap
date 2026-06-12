// Spatial grid over building footprints — blocks first-person walking
// through walls. Coarse (footprint-level), which is exactly right for a city walk.
import { projectRing, pointInRing } from './polyutil.js';

const CELL = 40;

export function buildCollisionIndex(buildings) {
  const cells = new Map();
  const entries = [];
  for (const b of buildings) {
    const ring = projectRing(b.outer);
    if (ring.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const v of ring) {
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.y); maxZ = Math.max(maxZ, v.y);
    }
    const holes = (b.holes ?? []).map(projectRing).filter((h) => h.length >= 3);
    const idx = entries.push({ ring, holes, minX, maxX, minZ, maxZ }) - 1;
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
    if (!bucket) return false;
    for (const i of bucket) {
      const e = entries[i];
      if (x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) continue;
      if (!pointInRing(x, z, e.ring)) continue;
      // courtyards are walkable
      let inHole = false;
      for (const h of e.holes) {
        if (pointInRing(x, z, h)) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
    return false;
  };
}

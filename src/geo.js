import { ORIGIN, BASE_ELEVATION, MAP_BBOX } from './config.js';

const M_PER_DEG_LAT = 111194;
const M_PER_DEG_LON = 111319.49 * Math.cos((ORIGIN.lat * Math.PI) / 180);

// Local scene coordinates: x = east (m), z = south (m), y = up (m, relative to BASE_ELEVATION)
export function project(lon, lat) {
  return {
    x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
    z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

export function unproject(x, z) {
  return {
    lon: ORIGIN.lon + x / M_PER_DEG_LON,
    lat: ORIGIN.lat - z / M_PER_DEG_LAT,
  };
}

export function elevationToY(ele) {
  return ele - BASE_ELEVATION;
}

// Local-space rectangle of the map extent, expanded by `margin` meters
export function getMapRect(margin = 0) {
  const a = project(MAP_BBOX.west, MAP_BBOX.south);
  const b = project(MAP_BBOX.east, MAP_BBOX.north);
  return {
    minX: Math.min(a.x, b.x) - margin,
    maxX: Math.max(a.x, b.x) + margin,
    minZ: Math.min(a.z, b.z) - margin,
    maxZ: Math.max(a.z, b.z) + margin,
  };
}

// Smooth value noise in [0,1) over 2D coordinates (1 unit = 1 noise cell)
export function noise2D(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const h = (i, j) => hash01(Math.imul(i, 374761393) + Math.imul(j, 668265263));
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return (
    (h(xi, yi) * (1 - sx) + h(xi + 1, yi) * sx) * (1 - sy) +
    (h(xi, yi + 1) * (1 - sx) + h(xi + 1, yi + 1) * sx) * sy
  );
}

// Deterministic pseudo-random in [0,1) from an integer seed
export function hash01(seed) {
  let h = seed | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

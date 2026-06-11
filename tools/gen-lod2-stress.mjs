// Generates a synthetic lod2.bin/json at production scale (~2.7M vertices)
// to reproduce LoD2 rendering issues without access to the real tiles.
// Usage: node tools/gen-lod2-stress.mjs <outDir>
import { writeFileSync, mkdirSync } from 'node:fs';

const outDir = process.argv[2] ?? '/tmp/lod2-stress';
mkdirSync(outDir, { recursive: true });

const positions = [];
const wins = [];
const flags = [];
const ranges = [];

// gabled box: 42 verts like a real LoD2 house
function house(cx, cz, w, d, h, roofH) {
  const start = positions.length / 3;
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  const yb = 0, ye = h, yr = h + roofH;
  const zm = cz;
  const quad = (a, b, c, dd, wall) => {
    for (const p of [a, b, c, a, c, dd]) {
      positions.push(Math.round(p[0] * 10), Math.round(p[1] * 10), Math.round(p[2] * 10));
      wins.push(Math.round(Math.abs(p[0] - x0 + p[2] - z0) * 10) % 8000, Math.max(0, Math.round(p[1] * 10)));
      flags.push(wall);
    }
  };
  // 4 walls
  quad([x0, yb, z0], [x1, yb, z0], [x1, ye, z0], [x0, ye, z0], 1);
  quad([x1, yb, z1], [x0, yb, z1], [x0, ye, z1], [x1, ye, z1], 1);
  quad([x0, yb, z1], [x0, yb, z0], [x0, ye, z0], [x0, ye, z1], 1);
  quad([x1, yb, z0], [x1, yb, z1], [x1, ye, z1], [x1, ye, z0], 1);
  // 2 roof planes
  quad([x0, ye, z0], [x1, ye, z0], [x1, yr, zm], [x0, yr, zm], 0);
  quad([x1, ye, z1], [x0, ye, z1], [x0, yr, zm], [x1, yr, zm], 0);
  // ground
  quad([x0, yb, z0], [x0, yb, z1], [x1, yb, z1], [x1, yb, z0], 0);
  // one intentionally degenerate sliver (zero area) like real quantized data
  for (let k = 0; k < 3; k++) {
    positions.push(Math.round(x0 * 10), 0, Math.round(z0 * 10));
    wins.push(0, 0);
    flags.push(0);
  }
  ranges.push({
    s: start,
    n: positions.length / 3 - start,
    cx: Math.round(cx * 10) / 10,
    cz: Math.round(cz * 10) / 10,
    minH: 0,
    eave: h,
  });
}

const COUNT = 60000;
const grid = Math.ceil(Math.sqrt(COUNT));
const span = 4600; // meters across the map
for (let i = 0; i < COUNT; i++) {
  const gx = (i % grid) / grid - 0.5;
  const gz = Math.floor(i / grid) / grid - 0.5;
  house(gx * span, gz * span, 8 + (i % 7), 6 + (i % 5), 6 + (i % 9), 2 + (i % 4));
}

const n = positions.length / 3;
const bin = Buffer.alloc(n * 11);
let off = 0;
for (let i = 0; i < n * 3; i++) {
  bin.writeInt16LE(Math.max(-32768, Math.min(32767, positions[i])), off);
  off += 2;
}
for (let i = 0; i < n * 2; i++) {
  bin.writeUInt16LE(Math.min(65535, wins[i]), off);
  off += 2;
}
for (let i = 0; i < n; i++) {
  bin.writeUInt8(flags[i], off);
  off += 1;
}
writeFileSync(`${outDir}/lod2.bin`, bin);
writeFileSync(`${outDir}/lod2.json`, JSON.stringify({ version: 1, vertexCount: n, buildings: ranges }));
console.log(`${outDir}: ${ranges.length} buildings, ${n} vertices, ${(bin.length / 1e6).toFixed(1)} MB`);

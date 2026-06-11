import * as THREE from 'three';
import { hash01 } from './geo.js';
import { groundY } from './terrain.js';
import { projectRing, ringArea, triangulatePolygon, subdivideTriangles, pointInRing } from './polyutil.js';

const KIND_COLORS = {
  green: new THREE.Color(0x32432d),
  forest: new THREE.Color(0x27351f),
  vineyard: new THREE.Color(0x3d4a2a),
  cemetery: new THREE.Color(0x2e3a2c),
};
const KIND_TREE_DENSITY = {
  // trees per square meter
  forest: 1 / 380,
  green: 1 / 900,
  cemetery: 1 / 700,
  vineyard: 1 / 2400,
};

export function buildGreenery(greens) {
  const pos = [];
  const col = [];
  const idx = [];
  const treeSpots = [];
  let treeBudget = 6500;

  for (const g of greens) {
    const ring = projectRing(g.outer);
    if (ring.length < 3) continue;
    const area = Math.abs(ringArea(ring));
    if (area < 40) continue;

    const tri = triangulatePolygon(ring, []);
    if (!tri) continue;
    const { verts, tris } = subdivideTriangles(tri.points, tri.triangles, 30);
    const color = KIND_COLORS[g.kind] ?? KIND_COLORS.green;
    const offset = pos.length / 3;
    for (const v of verts) {
      pos.push(v.x, groundY(v.x, v.y) + 0.22, v.y);
      const shade = 0.9 + hash01(Math.round(v.x * 13 + v.y * 7)) * 0.2;
      col.push(color.r * shade, color.g * shade, color.b * shade);
    }
    for (const [a, b, c] of tris) idx.push(offset + a, offset + b, offset + c);

    // scatter trees
    const density = KIND_TREE_DENSITY[g.kind] ?? 0;
    let want = Math.min(Math.floor(area * density), treeBudget);
    if (want <= 0) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const v of ring) {
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.y); maxZ = Math.max(maxZ, v.y);
    }
    let attempts = want * 8;
    while (want > 0 && attempts-- > 0) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      if (!pointInRing(x, z, ring)) continue;
      treeSpots.push({ x, z, small: g.kind === 'vineyard' });
      want--;
      treeBudget--;
    }
    if (treeBudget <= 0) break;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })
  );
  mesh.receiveShadow = true;
  mesh.name = 'greenery';

  return { mesh, trees: buildTrees(treeSpots) };
}

function buildTrees(spots) {
  if (!spots.length) return null;
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  const mesh = new THREE.InstancedMesh(crownGeo, mat, spots.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const palette = [0x2a4423, 0x33502a, 0x223a1e, 0x3a5530];

  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const r = s.small ? 0.9 + Math.random() * 0.5 : 2.0 + Math.random() * 1.8;
    const y = groundY(s.x, s.z) + r * 0.9;
    dummy.position.set(s.x, y, s.z);
    dummy.scale.set(r, r * (1.05 + Math.random() * 0.35), r);
    dummy.rotation.y = Math.random() * Math.PI;
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    color.setHex(palette[Math.floor(Math.random() * palette.length)]);
    color.multiplyScalar(0.85 + Math.random() * 0.3);
    mesh.setColorAt(i, color);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'trees';
  return mesh;
}

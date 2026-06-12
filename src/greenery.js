import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01, getMapRect } from './geo.js';
import { groundY, applyGroundDetail } from './terrain.js';
import {
  projectRing,
  ringArea,
  triangulatePolygon,
  subdivideTriangles,
  pointInRing,
  clipRingToRect,
} from './polyutil.js';

const KIND_COLORS = {
  green: new THREE.Color(0x32432d),
  forest: new THREE.Color(0x27351f),
  vineyard: new THREE.Color(0x3d4a2a),
  cemetery: new THREE.Color(0x2e3a2c),
  plaza: new THREE.Color(0x5e574a), // paved squares & pedestrian areas
  parking: new THREE.Color(0x46484c),
  urban: new THREE.Color(0x4f4a3f), // residential/commercial block ground
};
const KIND_TREE_DENSITY = {
  // trees per square meter
  forest: 1 / 380,
  green: 1 / 900,
  cemetery: 1 / 700,
  vineyard: 1 / 2400,
  plaza: 1 / 4500,
  urban: 1 / 2800, // scattered courtyard trees
};
// drape height: urban base sits below greens/plazas so parks stay visible
const KIND_OFFSET = { urban: 0.15, plaza: 0.45, parking: 0.42 };

export function buildGreenery(greens) {
  const pos = [];
  const col = [];
  const idx = [];
  const treeSpots = [];
  let treeBudget = 6500;

  const rect = getMapRect(450);
  for (const g of greens) {
    const ring = clipRingToRect(projectRing(g.outer), rect);
    if (ring.length < 3) continue;
    const area = Math.abs(ringArea(ring));
    if (area < 40) continue;

    const tri = triangulatePolygon(ring, []);
    if (!tri) continue;
    const { verts, tris } = subdivideTriangles(tri.points, tri.triangles, 30);
    const color = KIND_COLORS[g.kind] ?? KIND_COLORS.green;
    const yOff = KIND_OFFSET[g.kind] ?? 0.4;
    const offset = pos.length / 3;
    for (const v of verts) {
      pos.push(v.x, groundY(v.x, v.y) + yOff, v.y);
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
    applyGroundDetail(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })
    )
  );
  mesh.receiveShadow = true;
  mesh.name = 'greenery';

  return { mesh, trees: buildTrees(treeSpots) };
}

export const treeUniforms = { uTime: { value: 0 } };

// Organic stylized tree: tapered trunk + three noise-displaced crown lobes
// with a vertical light gradient baked into vertex colors. Wind sway happens
// per-instance in the vertex shader.
function makeTreeGeometry() {
  const paintGradient = (geo, bottom, top, y0, y1) => {
    const pos = geo.attributes.position;
    const arr = new Float32Array(pos.count * 3);
    const cb = new THREE.Color(bottom);
    const ct = new THREE.Color(top);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / (y1 - y0)));
      c.copy(cb).lerp(ct, t);
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  };

  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.07, 0.17, 1.3, 6).toNonIndexed().translate(0, 0.55, 0);
  parts.push(paintGradient(trunk, 0x4a3621, 0x5d452c, 0, 1.3));

  const lobes = [
    { r: 1.0, x: 0, y: 1.7, z: 0 },
    { r: 0.7, x: 0.55, y: 1.35, z: 0.32 },
    { r: 0.66, x: -0.48, y: 1.5, z: -0.34 },
  ];
  const v = new THREE.Vector3();
  for (const l of lobes) {
    const lobe = new THREE.IcosahedronGeometry(l.r, 1);
    // displace along the radius so the canopy reads organic, not crystalline
    const pos = lobe.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = hash01(Math.round(v.x * 53 + v.y * 271 + v.z * 97 + l.r * 1000));
      v.multiplyScalar(1 + (n - 0.5) * 0.42);
      pos.setXYZ(i, v.x, v.y * 0.92, v.z);
    }
    lobe.translate(l.x, l.y, l.z);
    // darker toward the trunk, light at the sun-facing top
    parts.push(paintGradient(lobe, 0x686868, 0xffffff, 0.7, 2.6));
  }
  const geo = mergeGeometries(parts);
  geo.computeVertexNormals();
  return geo;
}

function buildTrees(spots) {
  if (!spots.length) return null;
  const geo = makeTreeGeometry();
  if (!geo) {
    console.warn('[greenery] Baum-Geometrie fehlgeschlagen — keine Bäume');
    return null;
  }
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.9,
    metalness: 0,
    vertexColors: true,
    flatShading: true,
  });
  // gentle per-instance wind sway on the canopy
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, treeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          vec3 ipos = vec3(instanceMatrix[3]);
          float amp = smoothstep(0.7, 2.4, transformed.y) * 0.05;
          transformed.x += sin(uTime * 1.3 + ipos.x * 0.21 + ipos.z * 0.17) * amp;
          transformed.z += cos(uTime * 1.1 + ipos.x * 0.13 + ipos.z * 0.23) * amp;
        }
        #endif`
      );
  };
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const palette = [0x37502e, 0x405c36, 0x2e4527, 0x49603a];

  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const r = s.small ? 0.8 + Math.random() * 0.4 : 1.6 + Math.random() * 1.4;
    dummy.position.set(s.x, groundY(s.x, s.z), s.z);
    dummy.scale.set(r, r * (1.1 + Math.random() * 0.4), r);
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

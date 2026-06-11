import * as THREE from 'three';
import { getMapRect } from './geo.js';
import { groundY } from './terrain.js';
import { projectRing, triangulatePolygon, clipRingToRect } from './polyutil.js';

export const waterUniforms = {
  u_time: { value: 0 },
  u_sunDir: { value: new THREE.Vector3(0.3, 0.4, -0.6).normalize() },
  u_sunColor: { value: new THREE.Color(0xffb070) },
  u_skyZenith: { value: new THREE.Color(0x1c2b4d) },
  u_skyHorizon: { value: new THREE.Color(0xff9d5c) },
  u_deepColor: { value: new THREE.Color(0x0a141c) },
};

/**
 * Prepares water geometry data. Returns:
 *  - level: water surface y
 *  - mask(x, z): water level if the point is inside a water polygon, else null
 *  - build(): THREE.Mesh of the animated water surface
 */
export function prepareWater(waterPolys) {
  // rivers extend far beyond the map; clip everything to the rendered extent
  const rect = getMapRect(500);
  const polys = waterPolys
    .map((p) => ({
      outer: clipRingToRect(projectRing(p.outer), rect),
      holes: p.holes
        .map((h) => clipRingToRect(projectRing(h), rect))
        .filter((h) => h.length >= 3),
    }))
    .filter((p) => p.outer.length >= 3);

  if (!polys.length) {
    return { level: 0, mask: () => null, build: () => new THREE.Group() };
  }

  // Water level: low percentile of terrain height along the banks
  const samples = [];
  for (const p of polys) {
    for (let i = 0; i < p.outer.length; i += 2) {
      samples.push(groundY(p.outer[i].x, p.outer[i].y));
    }
  }
  samples.sort((a, b) => a - b);
  const level = samples[Math.floor(samples.length * 0.12)] - 0.3;

  // Rasterized mask over the bounding box of all water polys for O(1) lookups
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of polys) {
    for (const v of p.outer) {
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.y); maxZ = Math.max(maxZ, v.y);
    }
  }
  const res = 3; // meters per cell
  const gw = Math.max(2, Math.ceil((maxX - minX) / res));
  const gh = Math.max(2, Math.ceil((maxZ - minZ) / res));
  const canvas = document.createElement('canvas');
  canvas.width = gw;
  canvas.height = gh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, gw, gh);
  ctx.fillStyle = '#fff';
  for (const p of polys) {
    ctx.beginPath();
    p.outer.forEach((v, i) => {
      const cx = (v.x - minX) / res;
      const cy = (v.y - minZ) / res;
      i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    });
    ctx.closePath();
    for (const h of p.holes) {
      h.forEach((v, i) => {
        const cx = (v.x - minX) / res;
        const cy = (v.y - minZ) / res;
        i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  const maskData = ctx.getImageData(0, 0, gw, gh).data;

  const mask = (x, z) => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return null;
    const cx = Math.min(gw - 1, Math.floor((x - minX) / res));
    const cy = Math.min(gh - 1, Math.floor((z - minZ) / res));
    return maskData[(cy * gw + cx) * 4] > 127 ? level : null;
  };

  const build = () => {
    const pos = [];
    const idx = [];
    for (const p of polys) {
      const tri = triangulatePolygon(p.outer, p.holes);
      if (!tri) continue;
      const offset = pos.length / 3;
      for (const v of tri.points) pos.push(v.x, level, v.y);
      for (const [a, b, c] of tri.triangles) idx.push(offset + a, offset + b, offset + c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float u_time;
        uniform vec3 u_sunDir;
        uniform vec3 u_sunColor;
        uniform vec3 u_skyZenith;
        uniform vec3 u_skyHorizon;
        uniform vec3 u_deepColor;
        varying vec3 vWorldPos;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }
        float waveHeight(vec2 p) {
          // Main flows roughly northward (-z); waves drift with it
          vec2 flow = vec2(0.12, -0.65) * u_time;
          float h = 0.0;
          h += noise(p * 0.08 + flow) * 0.55;
          h += noise(p * 0.22 - flow * 1.4 + 17.0) * 0.3;
          h += noise(p * 0.6 + flow * 2.2 + 43.0) * 0.15;
          return h;
        }
        void main() {
          vec2 p = vWorldPos.xz;
          float e = 0.55;
          float h0 = waveHeight(p);
          float hx = waveHeight(p + vec2(e, 0.0));
          float hz = waveHeight(p + vec2(0.0, e));
          vec3 normal = normalize(vec3((h0 - hx) * 1.6, 1.0, (h0 - hz) * 1.6));

          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.0);
          fresnel = mix(0.12, 1.0, fresnel);

          vec3 reflDir = reflect(-viewDir, normal);
          float horizonness = 1.0 - max(reflDir.y, 0.0);
          vec3 skyRefl = mix(u_skyZenith, u_skyHorizon, pow(horizonness, 2.2));

          vec3 color = mix(u_deepColor, skyRefl, fresnel);

          // sun / moon glint
          float spec = pow(max(dot(reflDir, normalize(u_sunDir)), 0.0), 220.0);
          color += u_sunColor * spec * 2.4;
          // broad glitter path
          float glitter = pow(max(dot(reflDir, normalize(u_sunDir)), 0.0), 18.0);
          color += u_sunColor * glitter * 0.18;

          gl_FragColor = vec4(color, 0.96);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'water';
    mesh.renderOrder = 2;
    return mesh;
  };

  return { level, mask, build };
}

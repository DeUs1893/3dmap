import * as THREE from 'three';
import { getMapRect } from './geo.js';
import { groundY } from './terrain.js';
import { projectRing, clipRingToRect, clipPathToRect, ringArea } from './polyutil.js';

export const waterUniforms = {
  u_time: { value: 0 },
  u_sunDir: { value: new THREE.Vector3(0.3, 0.4, -0.6).normalize() },
  u_sunColor: { value: new THREE.Color(0xffb070) },
  u_skyZenith: { value: new THREE.Color(0x1c2b4d) },
  u_skyHorizon: { value: new THREE.Color(0xff9d5c) },
  u_deepColor: { value: new THREE.Color(0x121d18) }, // muddy river green
  u_reflMap: { value: null },
  u_textureMatrix: { value: new THREE.Matrix4() },
  u_reflStrength: { value: 1 },
};

/**
 * Prepares water geometry data. Returns:
 *  - level: water surface y
 *  - mask(x, z): water level if the point is inside a water polygon, else null
 *  - build(): THREE.Mesh of the animated, planar-reflecting water surface
 */
export function prepareWater(waterPolys, riverLines = []) {
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

  // Fallback: if the bank polygons are missing/broken, draw the river from its
  // centerline (waterway=river) buffered by its width.
  const polyArea = polys.reduce((s, p) => s + Math.abs(ringArea(p.outer)), 0);
  const strokes = [];
  if (polyArea < 60000) {
    for (const line of riverLines) {
      for (const piece of clipPathToRect(projectRing(line.path), rect)) {
        if (piece.length >= 2) strokes.push({ pts: piece, width: line.width });
      }
    }
    console.info(
      `[water] bank polygons cover only ${Math.round(polyArea)} m² — falling back to ${strokes.length} centerline strokes`
    );
  }

  if (!polys.length && !strokes.length) {
    return { level: 0, mask: () => null, build: () => new THREE.Group() };
  }

  // Water level: low percentile of terrain height along banks / centerlines
  const samples = [];
  for (const p of polys) {
    for (let i = 0; i < p.outer.length; i += 2) {
      samples.push(groundY(p.outer[i].x, p.outer[i].y));
    }
  }
  for (const s of strokes) {
    for (const v of s.pts) samples.push(groundY(v.x, v.y));
  }
  samples.sort((a, b) => a - b);
  const level = samples[Math.floor(samples.length * 0.12)] - 0.3;

  // Rasterized mask over the bounding box of all water shapes for O(1) lookups
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of polys) {
    for (const v of p.outer) {
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minZ = Math.min(minZ, v.y); maxZ = Math.max(maxZ, v.y);
    }
  }
  for (const s of strokes) {
    for (const v of s.pts) {
      minX = Math.min(minX, v.x - s.width); maxX = Math.max(maxX, v.x + s.width);
      minZ = Math.min(minZ, v.y - s.width); maxZ = Math.max(maxZ, v.y + s.width);
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
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.lineWidth = Math.max(2, s.width / res);
    ctx.beginPath();
    s.pts.forEach((v, i) => {
      const cx = (v.x - minX) / res;
      const cy = (v.y - minZ) / res;
      i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    });
    ctx.stroke();
  }
  const maskData = ctx.getImageData(0, 0, gw, gh).data;

  const mask = (x, z) => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return null;
    const cx = Math.min(gw - 1, Math.floor((x - minX) / res));
    const cy = Math.min(gh - 1, Math.floor((z - minZ) / res));
    return maskData[(cy * gw + cx) * 4] > 127 ? level : null;
  };

  // The surface mesh is generated from the raster mask instead of triangulating
  // the (often fragmented) OSM multipolygons — guarantees full river coverage.
  const build = () => {
    const pos = [];
    const idx = [];
    const cornerIndex = new Map();
    const corner = (cx, cy) => {
      const key = cy * (gw + 1) + cx;
      let i = cornerIndex.get(key);
      if (i === undefined) {
        i = pos.length / 3;
        pos.push(minX + cx * res, level, minZ + cy * res);
        cornerIndex.set(key, i);
      }
      return i;
    };
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        if (maskData[(cy * gw + cx) * 4] <= 127) continue;
        const a = corner(cx, cy);
        const b = corner(cx + 1, cy);
        const c = corner(cx + 1, cy + 1);
        const d = corner(cx, cy + 1);
        idx.push(a, c, b, a, d, c); // upward-facing in (x, z)
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform mat4 u_textureMatrix;
        varying vec3 vWorldPos;
        varying vec4 vReflCoord;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vReflCoord = u_textureMatrix * wp;
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
        uniform sampler2D u_reflMap;
        uniform float u_reflStrength;
        varying vec3 vWorldPos;
        varying vec4 vReflCoord;

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

          // planar reflection of the actual scene, distorted by the waves
          vec3 reflection = skyRefl;
          if (u_reflStrength > 0.01) {
            vec2 reflUv = vReflCoord.xy / vReflCoord.w + normal.xz * 0.06;
            vec3 tex = texture2D(u_reflMap, clamp(reflUv, 0.001, 0.999)).rgb;
            reflection = mix(skyRefl, tex, u_reflStrength * 0.85);
          }

          vec3 color = mix(u_deepColor, reflection, fresnel);

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
    attachReflector(mesh, level);
    return mesh;
  };

  return { level, mask, build };
}

// ---------------------------------------------------------------------------
// Planar reflection pass (adapted from three.js Reflector)
// ---------------------------------------------------------------------------
function attachReflector(mesh, level) {
  const renderTarget = new THREE.WebGLRenderTarget(1024, 1024);
  waterUniforms.u_reflMap.value = renderTarget.texture;

  const clipBias = 0.003;
  const planePoint = new THREE.Vector3(0, level, 0);
  const normal = new THREE.Vector3(0, 1, 0);
  const reflectorPlane = new THREE.Plane();
  const cameraWorldPosition = new THREE.Vector3();
  const rotationMatrix = new THREE.Matrix4();
  const lookAtPosition = new THREE.Vector3();
  const clipPlane = new THREE.Vector4();
  const view = new THREE.Vector3();
  const target = new THREE.Vector3();
  const q = new THREE.Vector4();
  const virtualCamera = new THREE.PerspectiveCamera();
  let rendering = false;

  mesh.onBeforeRender = (renderer, scene, camera) => {
    if (rendering || !camera.isPerspectiveCamera) return;
    if (waterUniforms.u_reflStrength.value < 0.01) return;

    cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    if (cameraWorldPosition.y < level) return; // camera under water

    rendering = true;

    view.subVectors(planePoint, cameraWorldPosition);
    view.reflect(normal).negate();
    view.add(planePoint);

    rotationMatrix.extractRotation(camera.matrixWorld);
    lookAtPosition.set(0, 0, -1).applyMatrix4(rotationMatrix).add(cameraWorldPosition);
    target.subVectors(planePoint, lookAtPosition);
    target.reflect(normal).negate();
    target.add(planePoint);

    virtualCamera.position.copy(view);
    virtualCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix).reflect(normal);
    virtualCamera.lookAt(target);
    virtualCamera.near = camera.near;
    virtualCamera.far = camera.far;
    virtualCamera.updateMatrixWorld();
    virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

    // texture matrix: world → reflection texture coordinates
    waterUniforms.u_textureMatrix.value
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(virtualCamera.projectionMatrix)
      .multiply(virtualCamera.matrixWorldInverse);

    // oblique near-plane clipping at the water surface
    reflectorPlane.setFromNormalAndCoplanarPoint(normal, planePoint);
    reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);
    clipPlane.set(
      reflectorPlane.normal.x,
      reflectorPlane.normal.y,
      reflectorPlane.normal.z,
      reflectorPlane.constant
    );
    const proj = virtualCamera.projectionMatrix;
    q.x = (Math.sign(clipPlane.x) + proj.elements[8]) / proj.elements[0];
    q.y = (Math.sign(clipPlane.y) + proj.elements[9]) / proj.elements[5];
    q.z = -1.0;
    q.w = (1.0 + proj.elements[10]) / proj.elements[14];
    clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
    proj.elements[2] = clipPlane.x;
    proj.elements[6] = clipPlane.y;
    proj.elements[10] = clipPlane.z + 1.0 - clipBias;
    proj.elements[14] = clipPlane.w;

    mesh.visible = false;
    const currentRenderTarget = renderer.getRenderTarget();
    const currentXrEnabled = renderer.xr.enabled;
    const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(renderTarget);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, virtualCamera);
    renderer.xr.enabled = currentXrEnabled;
    renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
    renderer.setRenderTarget(currentRenderTarget);
    mesh.visible = true;

    rendering = false;
  };
}

import * as THREE from 'three';
import { ORIGIN } from './config.js';
import { buildingUniforms } from './buildings.js';
import { waterUniforms } from './water.js';
import { sunPosition, dateAtMinutes } from './sun.js';

// Keyframes: 0 = Nachmittag, 0.5 = Dämmerung, 1 = Nacht
const KEYS = [
  {
    t: 0,
    lightAz: 205, lightEl: 46, lightColor: 0xfff0d4, lightIntensity: 3.0,
    hemiSky: 0xa8c8f0, hemiGround: 0x7d7660, hemiIntensity: 0.6,
    zenith: 0x2a5ca8, horizon: 0xb9d2e8, fog: 0xa9c2d8, fogDensity: 0.00006,
    windowGlow: 0.0, litRatio: 0.1, floodGlow: 0.0, lampOpacity: 0.0,
    starAlpha: 0.0, exposure: 1.0, sunGlow: 0.6,
  },
  {
    t: 0.5,
    lightAz: 283, lightEl: 7, lightColor: 0xff9248, lightIntensity: 1.35,
    hemiSky: 0x4a5a8a, hemiGround: 0x3a342c, hemiIntensity: 0.5,
    zenith: 0x1c2b4d, horizon: 0xff9d5c, fog: 0x3a3a55, fogDensity: 0.00012,
    windowGlow: 1.05, litRatio: 0.45, floodGlow: 0.3, lampOpacity: 0.85,
    starAlpha: 0.25, exposure: 1.05, sunGlow: 1.0,
  },
  {
    t: 1,
    lightAz: 115, lightEl: 40, lightColor: 0x93aadd, lightIntensity: 0.45,
    hemiSky: 0x222e52, hemiGround: 0x191713, hemiIntensity: 0.42,
    zenith: 0x05080f, horizon: 0x131c33, fog: 0x0a0e1a, fogDensity: 0.00013,
    windowGlow: 1.7, litRatio: 0.55, floodGlow: 0.55, lampOpacity: 1.0,
    starAlpha: 1.0, exposure: 1.12, sunGlow: 0.35,
  },
];

const COLOR_KEYS = new Set(['lightColor', 'hemiSky', 'hemiGround', 'zenith', 'horizon', 'fog']);

function lerpKeys(t) {
  const a = t <= 0.5 ? KEYS[0] : KEYS[1];
  const b = t <= 0.5 ? KEYS[1] : KEYS[2];
  const f = THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1);
  const s = f * f * (3 - 2 * f);
  const out = {};
  for (const k of Object.keys(a)) {
    if (k === 't') continue;
    if (COLOR_KEYS.has(k)) {
      out[k] = new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), s);
    } else {
      out[k] = a[k] + (b[k] - a[k]) * s;
    }
  }
  return out;
}

export class Atmosphere {
  constructor(scene, renderer) {
    this.renderer = renderer;
    this.scene = scene;

    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -2400; sc.right = 2400; sc.top = 2400; sc.bottom = -2400;
    sc.near = 100; sc.far = 9000;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 2.0;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x8a8474, 0.8);
    scene.add(this.hemi);

    scene.fog = new THREE.FogExp2(0x3a3a55, 0.00012);

    this.skyUniforms = {
      u_zenith: { value: new THREE.Color(0x1c2b4d) },
      u_horizon: { value: new THREE.Color(0xff9d5c) },
      u_fog: { value: new THREE.Color(0x3a3a55) },
      u_sunDir: { value: new THREE.Vector3(0, 1, 0) },
      u_sunColor: { value: new THREE.Color(0xff9248) },
      u_sunGlow: { value: 1 },
      u_starAlpha: { value: 0.3 },
    };
    const skyGeo = new THREE.SphereGeometry(14000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 u_zenith;
        uniform vec3 u_horizon;
        uniform vec3 u_fog;
        uniform vec3 u_sunDir;
        uniform vec3 u_sunColor;
        uniform float u_sunGlow;
        uniform float u_starAlpha;
        varying vec3 vDir;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        void main() {
          vec3 dir = normalize(vDir);
          float up = max(dir.y, 0.0);
          vec3 col = mix(u_horizon, u_zenith, pow(up, 0.55));
          // blend toward fog near and below the horizon so terrain silhouettes dissolve
          col = mix(u_fog, col, smoothstep(0.0, 0.18, dir.y));
          if (dir.y < 0.0) col = u_fog;

          float sunDot = max(dot(dir, normalize(u_sunDir)), 0.0);
          col += u_sunColor * pow(sunDot, 6000.0) * 8.0 * u_sunGlow;  // disc
          col += u_sunColor * pow(sunDot, 180.0) * 0.5 * u_sunGlow;   // corona
          col += u_sunColor * pow(sunDot, 8.0) * 0.16 * u_sunGlow;    // haze

          // stars (point-like inside their hash cell)
          vec2 sp = vec2(atan(dir.z, dir.x) * 110.0, dir.y * 330.0);
          vec2 cell = floor(sp);
          vec2 cf = fract(sp) - vec2(hash(cell + 3.0), hash(cell + 11.0));
          float star = step(0.985, hash(cell)) * smoothstep(0.16, 0.02, length(cf));
          float tw = 0.5 + 0.5 * hash(cell + 7.0);
          col += vec3(0.9, 0.95, 1.0) * star * tw * u_starAlpha * smoothstep(0.0, 0.2, dir.y);

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.skyMesh.name = 'sky';
    this.skyMesh.frustumCulled = false;
    scene.add(this.skyMesh);

    this.lampMaterials = [];
    this.setTime(0.5);
  }

  registerLampMaterial(mat, baseOpacity = 1) {
    this.lampMaterials.push({ mat, baseOpacity });
  }

  /** Sets the scene to the real solar position for "today at N minutes". */
  setClock(minutes) {
    this.minutes = minutes;
    const { azimuth, elevation } = sunPosition(dateAtMinutes(minutes), ORIGIN.lat, ORIGIN.lon);

    // map solar elevation to the day/dusk/night keyframe blend
    let t;
    if (elevation >= 30) t = 0;
    else if (elevation >= 0) t = ((30 - elevation) / 30) * 0.45;
    else if (elevation >= -6) t = 0.45 + (-elevation / 6) * 0.25;
    else if (elevation >= -14) t = 0.7 + ((-elevation - 6) / 8) * 0.3;
    else t = 1;

    this.setTime(t, { azimuth, elevation });
  }

  setTime(t, realSun = null) {
    this.time = t;
    const v = lerpKeys(t);

    // while the sun is (nearly) up, use its true position for light + sky
    const sunUp = realSun && realSun.elevation > -4;
    const lightAzDeg = sunUp ? realSun.azimuth : v.lightAz;
    const lightElDeg = sunUp ? Math.max(realSun.elevation, 1.5) : v.lightEl;

    const az = (lightAzDeg * Math.PI) / 180;
    const el = (lightElDeg * Math.PI) / 180;
    const dir = new THREE.Vector3(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      -Math.cos(az) * Math.cos(el)
    );
    // the visible sun disc may sink below the horizon even while light lingers
    let skyDir = dir;
    if (sunUp) {
      const sAz = (realSun.azimuth * Math.PI) / 180;
      const sEl = (realSun.elevation * Math.PI) / 180;
      skyDir = new THREE.Vector3(
        Math.sin(sAz) * Math.cos(sEl),
        Math.sin(sEl),
        -Math.cos(sAz) * Math.cos(sEl)
      );
    }
    this.sun.position.copy(dir).multiplyScalar(5000);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.copy(v.lightColor);
    this.sun.intensity = v.lightIntensity;
    this.sun.castShadow = true;

    this.hemi.color.copy(v.hemiSky);
    this.hemi.groundColor.copy(v.hemiGround);
    this.hemi.intensity = v.hemiIntensity;

    this.scene.fog.color.copy(v.fog);
    this.scene.fog.density = v.fogDensity;

    this.skyUniforms.u_zenith.value.copy(v.zenith);
    this.skyUniforms.u_horizon.value.copy(v.horizon);
    this.skyUniforms.u_fog.value.copy(v.fog);
    this.skyUniforms.u_sunDir.value.copy(skyDir);
    this.skyUniforms.u_sunColor.value.copy(v.lightColor);
    this.skyUniforms.u_sunGlow.value = v.sunGlow;
    this.skyUniforms.u_starAlpha.value = v.starAlpha;

    buildingUniforms.u_windowGlow.value = v.windowGlow;
    buildingUniforms.u_litRatio.value = v.litRatio;
    buildingUniforms.u_floodGlow.value = v.floodGlow;

    waterUniforms.u_sunDir.value.copy(skyDir);
    waterUniforms.u_sunColor.value.copy(v.lightColor).multiplyScalar(Math.max(v.sunGlow, 0.3));
    waterUniforms.u_skyZenith.value.copy(v.zenith);
    waterUniforms.u_skyHorizon.value.copy(v.horizon);

    for (const { mat, baseOpacity } of this.lampMaterials) {
      mat.opacity = baseOpacity * v.lampOpacity;
      mat.visible = v.lampOpacity > 0.02;
    }

    this.renderer.toneMappingExposure = v.exposure;
  }
}

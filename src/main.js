import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

import { LANDMARKS, MAP_BBOX, ORIGIN } from './config.js';
import { project } from './geo.js';
import { findDuskMinutes } from './sun.js';
import { loadTerrainData, buildTerrainMesh, groundY } from './terrain.js';
import { fetchOSM, parseOSM } from './osm.js';
import { buildBuildings } from './buildings.js';
import { buildRoads } from './roads.js';
import { makeGlowTexture, buildLamps, TrafficSystem } from './lights.js';
import { prepareWater, waterUniforms } from './water.js';
import { buildGreenery } from './greenery.js';
import { Atmosphere } from './sky.js';
import { CameraRig } from './cameraRig.js';

const $ = (id) => document.getElementById(id);
const setStatus = (msg) => ($('status').textContent = msg);
const setProgress = (f) => ($('progress').style.width = `${Math.round(f * 100)}%`);

async function boot() {
  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 2, 30000);
  camera.position.set(2400, 2800, 2600);
  camera.lookAt(0, 0, 0);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.style.position = 'fixed';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  labelRenderer.domElement.style.zIndex = '10';
  document.body.appendChild(labelRenderer.domElement);

  const composer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
      samples: 4,
      type: THREE.HalfFloatType,
    })
  );
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.updateGtaoMaterial({ radius: 6, distanceExponent: 1.5, thickness: 4, scale: 1.2 });
  composer.addPass(gtao);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.42,
    0.4,
    0.85
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------- data ----------
  setStatus('Lade Geländemodell …');
  setProgress(0.04);
  await loadTerrainData(import.meta.env.BASE_URL ?? './');
  setProgress(0.1);

  // Overpass sends no content-length; let the bar creep while we wait
  let creep = 0.1;
  const creepTimer = setInterval(() => {
    creep = Math.min(0.48, creep + (0.48 - creep) * 0.04);
    setProgress(creep);
  }, 250);
  let osmJson;
  try {
    osmJson = await fetchOSM(setStatus);
  } finally {
    clearInterval(creepTimer);
  }
  setProgress(0.5);
  setStatus('Verarbeite Stadtdaten …');
  await new Promise((r) => requestAnimationFrame(r));
  const data = parseOSM(osmJson);

  // ---------- layers ----------
  setStatus('Forme das Maintal …');
  const water = prepareWater(data.waterPolys);
  const { mesh: terrainMesh, bounds } = buildTerrainMesh(water.mask);
  scene.add(terrainMesh);
  scene.add(water.build());
  setProgress(0.58);
  await new Promise((r) => requestAnimationFrame(r));

  setStatus('Asphaltiere Straßen …');
  const { mesh: roadMesh, trafficPaths, tramPaths, statues } = buildRoads(data.roads, data.rails);
  scene.add(roadMesh);
  if (statues) scene.add(statues);
  setProgress(0.66);
  await new Promise((r) => requestAnimationFrame(r));

  setStatus('Pflanze Bäume …');
  const greenery = buildGreenery(data.greens);
  scene.add(greenery.mesh);
  if (greenery.trees) scene.add(greenery.trees);
  setProgress(0.72);
  await new Promise((r) => requestAnimationFrame(r));

  // Simple-3D: hulls detailed by building:part are replaced by their parts
  const renderBuildings = data.buildings.filter((b) => !b.hasParts).concat(data.parts);
  setStatus(`Errichte ${renderBuildings.length.toLocaleString('de-DE')} Gebäude …`);
  const buildingMesh = await buildBuildings(renderBuildings, (f) => setProgress(0.72 + f * 0.22));
  scene.add(buildingMesh);

  // ---------- lights & atmosphere ----------
  const glowTex = makeGlowTexture();
  const lamps = buildLamps(data.roads, glowTex);
  scene.add(lamps);
  const traffic = new TrafficSystem(trafficPaths, glowTex);
  scene.add(traffic.points);
  const trams = new TrafficSystem(tramPaths, glowTex, {
    metersPerVehicle: 600,
    maxCount: 24,
    minCount: 2,
    speedMin: 5,
    speedMax: 9,
    size: 8,
    colorForward: 0xfff0b8,
    colorBackward: 0xfff0b8,
    heightOffset: 2.2,
    name: 'trams',
  });
  scene.add(trams.points);

  const atmosphere = new Atmosphere(scene, renderer);
  atmosphere.registerLampMaterial(lamps.material, 0.9);
  atmosphere.registerLampMaterial(traffic.points.material, 1);
  atmosphere.registerLampMaterial(trams.points.material, 1);

  // ---------- camera rig ----------
  const rig = new CameraRig(camera, renderer.domElement, bounds);
  rig.onModeChange = (mode) => {
    $('help-orbit').classList.toggle('hidden', mode !== 'orbit');
    $('help-fly').classList.toggle('hidden', mode !== 'fly');
  };

  // ---------- landmarks ----------
  const labelObjects = [];
  const landmarkPos = (lm) => {
    const p = project(lm.lon, lm.lat);
    return new THREE.Vector3(p.x, groundY(p.x, p.z) + lm.labelHeight, p.z);
  };
  const flyToLandmark = (lm) => {
    const pos = landmarkPos(lm);
    const from = camera.position.clone().sub(pos);
    from.y = 0;
    if (from.lengthSq() < 1) from.set(1, 0, 1);
    from.normalize();
    const elevation = THREE.MathUtils.degToRad(26);
    const camPos = pos
      .clone()
      .addScaledVector(from, lm.viewDistance * Math.cos(elevation))
      .add(new THREE.Vector3(0, lm.viewDistance * Math.sin(elevation), 0));
    camPos.y = Math.max(camPos.y, groundY(camPos.x, camPos.z) + 25);
    rig.flyTo(camPos, pos, 2.6);
  };

  for (const lm of LANDMARKS) {
    const el = document.createElement('div');
    el.className = 'lm-label';
    el.innerHTML = `<span class="lm-name">${lm.name}</span><span class="lm-desc">${lm.desc}</span><span class="lm-pin"></span>`;
    el.addEventListener('click', () => flyToLandmark(lm));
    const obj = new CSS2DObject(el);
    obj.position.copy(landmarkPos(lm));
    scene.add(obj);
    labelObjects.push({ obj, el });

    const chip = document.createElement('button');
    chip.className = 'lm-chip';
    chip.textContent = lm.name;
    chip.addEventListener('click', () => flyToLandmark(lm));
    $('landmark-list').appendChild(chip);
  }

  // ---------- UI ----------
  const slider = $('time-slider');
  const timeLabel = $('time-label');
  const applyClock = (minutes) => {
    atmosphere.setClock(minutes);
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(Math.round(minutes % 60)).padStart(2, '0');
    timeLabel.textContent = `${h}:${m}`;
  };
  slider.addEventListener('input', (e) => applyClock(Number(e.target.value)));
  const duskMinutes = findDuskMinutes(ORIGIN.lat, ORIGIN.lon);
  slider.value = String(duskMinutes);
  applyClock(duskMinutes);

  const reflToggle = $('refl-toggle');
  reflToggle.addEventListener('click', () => {
    const on = waterUniforms.u_reflStrength.value < 0.5;
    waterUniforms.u_reflStrength.value = on ? 1 : 0;
    reflToggle.classList.toggle('on', on);
  });

  // address search via Nominatim, bounded to the map extent
  const searchInput = $('search');
  const searchHint = $('search-hint');
  const showHint = (text, sticky = false) => {
    searchHint.textContent = text;
    searchHint.classList.remove('hidden');
    if (!sticky) setTimeout(() => searchHint.classList.add('hidden'), 4000);
  };
  searchInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = searchInput.value.trim();
    if (!q) return;
    showHint('Suche …', true);
    try {
      const vb = `${MAP_BBOX.west},${MAP_BBOX.north},${MAP_BBOX.east},${MAP_BBOX.south}`;
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&bounded=1&viewbox=${vb}&q=${encodeURIComponent(q)}`
      );
      const list = await res.json();
      if (!list.length) {
        showHint('Nichts gefunden im Kartenausschnitt.');
        return;
      }
      const hit = list[0];
      const p = project(parseFloat(hit.lon), parseFloat(hit.lat));
      const pos = new THREE.Vector3(p.x, groundY(p.x, p.z) + 8, p.z);
      const from = camera.position.clone().sub(pos);
      from.y = 0;
      if (from.lengthSq() < 1) from.set(1, 0, 1);
      from.normalize();
      const dist = 260;
      const elv = THREE.MathUtils.degToRad(30);
      const camPos = pos
        .clone()
        .addScaledVector(from, dist * Math.cos(elv))
        .add(new THREE.Vector3(0, dist * Math.sin(elv), 0));
      camPos.y = Math.max(camPos.y, groundY(camPos.x, camPos.z) + 20);
      rig.flyTo(camPos, pos, 2.2);
      showHint(hit.display_name.split(',').slice(0, 2).join(','));
      searchInput.blur();
    } catch {
      showHint('Suche fehlgeschlagen — Nominatim nicht erreichbar.');
    }
  });

  $('hud-stats').textContent =
    `${renderBuildings.length.toLocaleString('de-DE')} Gebäude · ` +
    `${data.roads.length.toLocaleString('de-DE')} Wege · OpenStreetMap`;

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    gtao.setSize(w, h);
    bloom.setSize(w, h);
    labelRenderer.setSize(w, h);
  });

  // ---------- go ----------
  setProgress(1);
  setStatus('Fertig');
  $('hud').classList.remove('hidden');
  $('loader').classList.add('fade');
  setTimeout(() => $('loader').remove(), 1400);

  // intro flight: vista from the old town across the Main to the fortress
  const festung = LANDMARKS[0];
  const fp = project(festung.lon, festung.lat);
  const lookAt = new THREE.Vector3(fp.x, groundY(fp.x, fp.z) + 40, fp.z);
  rig.orbit.target.set(0, 0, 0);
  rig.flyTo(new THREE.Vector3(fp.x + 780, lookAt.y + 210, fp.z + 120), lookAt, 4.5);

  // hooks for automated visual tests
  window.__APP_READY = true;
  window.__teleport = (cx, cy, cz, tx, ty, tz) => {
    rig.flight = null;
    camera.position.set(cx, cy, cz);
    rig.orbit.target.set(tx, ty, tz);
    camera.lookAt(rig.orbit.target);
  };

  // ---------- loop ----------
  const clock = new THREE.Clock();
  const tmpV = new THREE.Vector3();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    rig.update(dt);
    traffic.update(dt);
    trams.update(dt);
    waterUniforms.u_time.value += dt;

    // distance-based label fading
    for (const { obj, el } of labelObjects) {
      const d = tmpV.copy(obj.position).distanceTo(camera.position);
      const o = THREE.MathUtils.clamp(1.6 - d / 2200, 0, 1);
      el.style.opacity = o.toFixed(2);
      el.style.pointerEvents = o > 0.08 ? 'auto' : 'none';
    }

    composer.render();
    labelRenderer.render(scene, camera);
  });
}

boot().catch((err) => {
  console.error(err);
  $('loader')?.classList.add('fade');
  $('error').classList.remove('hidden');
  $('error-msg').textContent =
    `${err.message}. Die Karte benötigt eine Internetverbindung zu OpenStreetMap (Overpass API).`;
  $('retry').addEventListener('click', () => location.reload());
});

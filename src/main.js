import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

import { LANDMARKS, MAP_BBOX, ORIGIN } from './config.js';
import { project } from './geo.js';
import { findDuskMinutes } from './sun.js';
import { loadTerrainData, buildTerrainMesh, groundY } from './terrain.js';
import { fetchOSM, parseOSM } from './osm.js';
import { buildBuildings } from './buildings.js';
import { loadLOD2 } from './lod2.js';
import { buildRoads } from './roads.js';
import { makeGlowTexture, buildLamps, TrafficSystem } from './lights.js';
import { buildTravelGraph, AgentSystem, CarLights, buildCarMesh, buildPersonMesh } from './agents.js';
import { prepareWater, waterUniforms } from './water.js';
import { buildGreenery } from './greenery.js';
import { Atmosphere } from './sky.js';
import { CameraRig } from './cameraRig.js';
import { buildCollisionIndex } from './collision.js';
import { startBells } from './bells.js';

const $ = (id) => document.getElementById(id);
const setStatus = (msg) => ($('status').textContent = msg);
const setProgress = (f) => ($('progress').style.width = `${Math.round(f * 100)}%`);

async function boot() {
  // phones get a lite pipeline: no GTAO/reflections, smaller shadow map
  const isMobile =
    /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && Math.min(window.innerWidth, window.innerHeight) < 900);

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
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
  let gtao = null;
  if (!isMobile) {
    gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.5, thickness: 1.5, scale: 0.9 });
    composer.addPass(gtao);
  }
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.42,
    0.4,
    0.85
  );
  composer.addPass(bloom);
  // cinematic grade: gentle saturation, warm shadow lift, vignette
  const grade = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / window.innerWidth, 1 / window.innerHeight) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec4 color = texture2D(tDiffuse, vUv);
        // unsharp mask for perceived resolution
        vec3 nb =
          texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb +
          texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb +
          texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb +
          texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
        color.rgb = max(color.rgb * 1.48 - nb * 0.12, 0.0);
        float l = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        color.rgb = mix(vec3(l), color.rgb, 1.12);
        color.rgb += vec3(0.014, 0.007, -0.004) * (1.0 - smoothstep(0.0, 0.35, l));
        float d = distance(vUv, vec2(0.5));
        color.rgb *= 1.0 - 0.3 * smoothstep(0.48, 0.86, d);
        gl_FragColor = color;
      }
    `,
  });
  composer.addPass(grade);
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
  console.info(
    `[osm] ${data.buildings.length} Gebäude, ${data.parts.length} Teile, ` +
    `${data.waterPolys.length} Wasserpolygone, ${data.riverLines.length} Flusslinien`
  );
  const water = prepareWater(data.waterPolys, data.riverLines);
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

  // Surveyed LoD2 models (if baked) replace the extruded OSM buildings
  setStatus('Suche amtliche LoD2-Modelle …');
  const lod2 = await loadLOD2(import.meta.env.BASE_URL ?? './', data.buildings, water.mask);
  let buildingCount;
  if (lod2) {
    scene.add(lod2.mesh);
    buildingCount = lod2.count;
    setProgress(0.94);
  } else {
    // Simple-3D: hulls detailed by building:part are replaced by their parts
    const renderBuildings = data.buildings.filter((b) => !b.hasParts).concat(data.parts);
    buildingCount = renderBuildings.length;
    setStatus(`Errichte ${renderBuildings.length.toLocaleString('de-DE')} Gebäude …`);
    const buildingMesh = await buildBuildings(renderBuildings, (f) => setProgress(0.72 + f * 0.22));
    scene.add(buildingMesh);
  }

  // ---------- lights & atmosphere ----------
  const glowTex = makeGlowTexture();
  const lamps = buildLamps(data.roads, glowTex);
  scene.add(lamps);
  // living city: cars and pedestrians traveling a real street graph
  setStatus('Belebe die Stadt …');
  const carGraph = buildTravelGraph(data.roads, (r) => r <= 3, 7);
  const pedGraph = buildTravelGraph(data.roads, (r) => r >= 3 && r <= 6, 5);
  const carCount = isMobile ? 70 : 220;
  const pedCount = isMobile ? 110 : 380;
  const cars = new AgentSystem(carGraph, buildCarMesh(carCount), {
    count: carCount,
    speedMin: 6,
    speedMax: 11,
    spawnWeight: (e) => (e.rank <= 1 ? 2.5 : 1),
  });
  scene.add(cars.mesh);
  const people = new AgentSystem(pedGraph, buildPersonMesh(pedCount), {
    count: pedCount,
    speedMin: 0.9,
    speedMax: 1.7,
    pauseChance: 0.02,
    pauseMax: 18,
    bob: 0.04,
    spawnWeight: (e) => (e.rank === 4 ? 6 : e.rank === 6 ? 2 : 1),
  });
  scene.add(people.mesh);
  const carLights = new CarLights(cars, glowTex);
  scene.add(carLights.points);
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
  if (isMobile) {
    atmosphere.sun.shadow.mapSize.set(2048, 2048);
    waterUniforms.u_reflStrength.value = 0; // planar reflection pass off by default
  }
  atmosphere.registerLampMaterial(lamps.material, 0.9);
  atmosphere.registerLampMaterial(carLights.points.material, 1);
  atmosphere.registerLampMaterial(trams.points.material, 1);

  // ---------- camera rig ----------
  const rig = new CameraRig(camera, renderer.domElement, bounds);
  rig.isBlocked = buildCollisionIndex(data.buildings);
  rig.onModeChange = (mode) => {
    $('help-orbit').classList.toggle('hidden', mode !== 'orbit');
    $('help-fly').classList.toggle('hidden', mode !== 'fly');
    $('help-walk').classList.toggle('hidden', mode !== 'walk');
  };
  if (isMobile) {
    $('help-orbit').innerHTML =
      '<kbd>1 Finger</kbd> Drehen · <kbd>2 Finger</kbd> Zoomen &amp; Verschieben · <kbd>Tippen</kbd> auf Label fliegt hin';
  }

  // ---------- landmarks ----------
  const labelObjects = [];
  const landmarkPos = (lm) => {
    const p = project(lm.lon, lm.lat);
    return new THREE.Vector3(p.x, groundY(p.x, p.z) + lm.labelHeight, p.z);
  };
  const flyToLandmark = (lm) => {
    openWiki(lm); // hoisted; defined in the UI section below
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
  reflToggle.classList.toggle('on', waterUniforms.u_reflStrength.value > 0.5);
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
    `${buildingCount.toLocaleString('de-DE')} Gebäude${lod2 ? ' (amtl. LoD2)' : ''} · ` +
    `${data.roads.length.toLocaleString('de-DE')} Wege · OpenStreetMap`;

  // ---------- photo mode: render at 2x and download ----------
  $('photo-btn').addEventListener('click', async () => {
    const mult = 2;
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w * mult, h * mult, false);
    composer.setSize(w * mult, h * mult);
    grade.uniforms.uTexel.value.set(1 / (w * mult), 1 / (h * mult));
    composer.render();
    const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
    renderer.setSize(w, h);
    composer.setSize(w, h);
    grade.uniforms.uTexel.value.set(1 / w, 1 / h);
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wuerzburg3d_${timeLabel.textContent.replace(':', '-')}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------- share link: camera + target + clock in the URL hash ----------
  $('share-btn').addEventListener('click', async () => {
    const c = camera.position;
    const t = rig.orbit.target;
    const f = (v) => Math.round(v * 10) / 10;
    const hash = `#v=${f(c.x)},${f(c.y)},${f(c.z)}|${f(t.x)},${f(t.y)},${f(t.z)}|${slider.value}`;
    history.replaceState(null, '', hash);
    try {
      await navigator.clipboard.writeText(location.href);
      showHint('Link zu dieser Ansicht kopiert!');
    } catch {
      showHint(`Link: ${location.href}`);
    }
  });

  // restore a shared view (skips the intro flight)
  let restoredView = false;
  const viewMatch = location.hash.match(/#v=([^|]+)\|([^|]+)\|(\d+)/);
  if (viewMatch) {
    const [cx, cy, cz] = viewMatch[1].split(',').map(Number);
    const [tx, ty, tz] = viewMatch[2].split(',').map(Number);
    if ([cx, cy, cz, tx, ty, tz].every(Number.isFinite)) {
      camera.position.set(cx, cy, cz);
      rig.orbit.target.set(tx, ty, tz);
      camera.lookAt(rig.orbit.target);
      slider.value = viewMatch[3];
      applyClock(Number(viewMatch[3]));
      restoredView = true;
    }
  }

  // ---------- Wikipedia cards ----------
  const wikiCard = $('wiki-card');
  $('wiki-close').addEventListener('click', () => wikiCard.classList.add('hidden'));
  async function openWiki(lm) {
    if (!lm.wiki) return;
    try {
      const res = await fetch(
        `https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(lm.wiki)}`
      );
      if (!res.ok) return;
      const info = await res.json();
      $('wiki-title').textContent = info.title ?? lm.name;
      $('wiki-text').textContent = info.extract ?? lm.desc;
      $('wiki-link').href = info.content_urls?.desktop?.page ?? '#';
      const img = $('wiki-img');
      if (info.thumbnail?.source) {
        img.src = info.thumbnail.source;
        img.style.display = '';
      } else {
        img.style.display = 'none';
      }
      wikiCard.classList.remove('hidden');
    } catch {
      /* offline / blocked — silently skip */
    }
  }

  // ---------- cathedral bells on the real full hour ----------
  const domLm = LANDMARKS.find((l) => l.id === 'dom');
  const dp = project(domLm.lon, domLm.lat);
  const bells = startBells(camera, scene, new THREE.Vector3(dp.x, groundY(dp.x, dp.z) + 60, dp.z));

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    gtao?.setSize(w, h);
    bloom.setSize(w, h);
    grade.uniforms.uTexel.value.set(1 / w, 1 / h);
    labelRenderer.setSize(w, h);
  });

  // ---------- go ----------
  setProgress(1);
  setStatus('Fertig');
  $('hud').classList.remove('hidden');
  $('loader').classList.add('fade');
  setTimeout(() => $('loader').remove(), 1400);

  // intro flight: vista from the old town across the Main to the fortress
  // (skipped when a shared view was restored from the URL)
  if (!restoredView) {
    const festung = LANDMARKS[0];
    const fp = project(festung.lon, festung.lat);
    const lookAt = new THREE.Vector3(fp.x, groundY(fp.x, fp.z) + 40, fp.z);
    rig.orbit.target.set(0, 0, 0);
    rig.flyTo(new THREE.Vector3(fp.x + 780, lookAt.y + 210, fp.z + 120), lookAt, 4.5);
  }

  // hooks for automated visual tests
  window.__APP_READY = true;
  window.__teleport = (cx, cy, cz, tx, ty, tz) => {
    rig.flight = null;
    camera.position.set(cx, cy, cz);
    rig.orbit.target.set(tx, ty, tz);
    camera.lookAt(rig.orbit.target);
  };

  // ---------- loop ----------
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showError(new Error('WebGL-Kontext verloren — GPU überlastet oder Treiberproblem. Seite neu laden.'));
  });
  const clock = new THREE.Clock();
  const tmpV = new THREE.Vector3();
  let loopErrorShown = false;
  renderer.setAnimationLoop(() => {
    try {
      tick();
    } catch (err) {
      if (!loopErrorShown) {
        loopErrorShown = true;
        console.error(err);
        showError(err);
      }
    }
  });
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.1);
    rig.update(dt);
    atmosphere.track(rig.orbit.target);
    atmosphere.updateEnvironment();
    cars.update(dt, clock.elapsedTime);
    people.update(dt, clock.elapsedTime);
    carLights.update();
    trams.update(dt);
    bells.update();
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
  }
}

function showError(err) {
  $('loader')?.classList.add('fade');
  $('error').classList.remove('hidden');
  $('error-msg').textContent = `${err.message}`;
  $('retry').addEventListener('click', () => location.reload());
}

boot().catch((err) => {
  console.error(err);
  showError(
    new Error(`${err.message}. Die Karte benötigt eine Internetverbindung zu OpenStreetMap (Overpass API).`)
  );
});

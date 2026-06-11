// Visual verification harness: serves the built app, intercepts the Overpass
// request with a synthetic-but-plausible city (real terrain stays), and takes
// screenshots at day/dusk/night. Run `npm run build` first.
//
// Usage: node tools/screenshot.mjs [outDir]

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';

const OUT = process.argv[2] ?? '/tmp/shots';
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Synthetic OSM payload (geometry inline, like Overpass `out geom`)
// ---------------------------------------------------------------------------
function syntheticOSM() {
  const elements = [];
  let id = 1;
  const M_LON = 1 / 71866; // deg per meter
  const M_LAT = 1 / 111194;

  // Main river, flowing north through the real valley
  const course = [
    [9.9333, 49.778], [9.929, 49.785], [9.926, 49.7905], [9.9258, 49.7933],
    [9.927, 49.7965], [9.9286, 49.8], [9.93, 49.806],
  ];
  const half = 48 * M_LON;
  const left = course.map(([lon, lat]) => [lon - half, lat]);
  const right = course.map(([lon, lat]) => [lon + half, lat]).reverse();
  const riverRing = left.concat(right, [left[0]]);
  elements.push({
    type: 'way', id: id++, tags: { natural: 'water', water: 'river' },
    geometry: riverRing.map(([lon, lat]) => ({ lon, lat })),
  });

  const inRiver = (lon, lat) => {
    // distance to course polyline (coarse)
    for (const [clon, clat] of course) {
      if (Math.abs(lat - clat) < 0.004 && Math.abs(lon - clon) < 90 * M_LON) return true;
    }
    return false;
  };

  const rect = (lon, lat, w, d, angle) => {
    const ca = Math.cos(angle); const sa = Math.sin(angle);
    const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2]];
    return pts.map(([x, y]) => ({
      lon: lon + (x * ca - y * sa) * M_LON,
      lat: lat + (x * sa + y * ca) * M_LAT,
    }));
  };

  // Altstadt building cluster (east bank) + Zellerau (west bank)
  let rng = 12345;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const clusters = [
    { lon0: 9.9285, lon1: 9.9455, lat0: 49.786, lat1: 49.8015, step: 55, density: 0.85 },
    { lon0: 9.908, lon1: 9.921, lat0: 49.793, lat1: 49.803, step: 75, density: 0.5 },
  ];
  for (const c of clusters) {
    for (let lat = c.lat0; lat < c.lat1; lat += c.step * M_LAT) {
      for (let lon = c.lon0; lon < c.lon1; lon += c.step * M_LON) {
        if (rand() > c.density) continue;
        const jl = lon + (rand() - 0.5) * 28 * M_LON;
        const ja = lat + (rand() - 0.5) * 28 * M_LAT;
        if (inRiver(jl, ja)) continue;
        const w = 14 + rand() * 22;
        const d = 12 + rand() * 18;
        const tall = rand() > 0.96;
        elements.push({
          type: 'way', id: id++,
          tags: {
            building: tall ? 'church' : 'residential',
            height: String(tall ? 38 + rand() * 18 : 8 + rand() * 14),
          },
          geometry: rect(jl, ja, w, d, rand() * Math.PI),
        });
      }
    }
  }

  // "Festung" on the real Marienberg hill
  elements.push({
    type: 'way', id: id++, tags: { building: 'castle', height: '22', name: 'Festung Marienberg' },
    geometry: rect(9.9215, 49.7903, 130, 60, 0.3),
  });
  elements.push({
    type: 'way', id: id++, tags: { building: 'castle', height: '40', 'roof:shape': 'pyramidal', 'roof:height': '12' },
    geometry: rect(9.9212, 49.7905, 18, 18, 0.3),
  });

  // "Dom" exercising building:part: hull hidden, nave gabled, two pyramidal towers
  const domLon = 9.9402;
  const domLat = 49.7942;
  elements.push({
    type: 'way', id: id++, tags: { building: 'cathedral', name: 'Dom' },
    geometry: rect(domLon, domLat, 64, 26, 0),
  });
  elements.push({
    type: 'way', id: id++,
    tags: { 'building:part': 'yes', height: '24', 'roof:shape': 'gabled', 'roof:height': '9' },
    geometry: rect(domLon - 6 * M_LON, domLat, 48, 24, 0),
  });
  for (const dy of [-8, 8]) {
    elements.push({
      type: 'way', id: id++,
      tags: { 'building:part': 'yes', height: '56', 'roof:shape': 'pyramidal', 'roof:height': '16' },
      geometry: rect(domLon + 24 * M_LON, domLat + dy * M_LAT, 9, 9, 0),
    });
  }
  // floating part (bridge wing) to exercise min_height
  elements.push({
    type: 'way', id: id++,
    tags: { 'building:part': 'yes', height: '18', min_height: '12' },
    geometry: rect(domLon - 36 * M_LON, domLat, 14, 20, 0),
  });

  // tram line along the east bank
  elements.push({
    type: 'way', id: id++, tags: { railway: 'tram' },
    geometry: [
      { lon: 9.9335, lat: 49.787 },
      { lon: 9.9335, lat: 49.794 },
      { lon: 9.9335, lat: 49.801 },
    ],
  });

  // Roads: riverside primaries + grid + bridge at the Alte Mainbrücke spot
  const road = (pts, highway, extra = {}) =>
    elements.push({
      type: 'way', id: id++, tags: { highway, ...extra },
      geometry: pts.map(([lon, lat]) => ({ lon, lat })),
    });
  road(course.map(([lon, lat]) => [lon + 70 * M_LON, lat]), 'primary');
  road(course.map(([lon, lat]) => [lon - 70 * M_LON, lat]), 'secondary');
  road([[9.9225, 49.7931], [9.9292, 49.7936]], 'pedestrian', { bridge: 'yes', name: 'Alte Mainbrücke' });
  road([[9.9295, 49.788], [9.9455, 49.788]], 'secondary');
  road([[9.9295, 49.7935], [9.9455, 49.7935]], 'primary');
  road([[9.9295, 49.799], [9.9455, 49.799]], 'secondary');
  for (let lon = 9.931; lon < 9.945; lon += 0.0025) {
    road([[lon, 49.7865], [lon, 49.801]], 'residential');
  }
  for (let lat = 49.787; lat < 49.801; lat += 0.0022) {
    road([[9.9295, lat], [9.9455, lat]], 'residential');
  }

  // Greens: forest on the Marienberg slopes, park near the Residenz, vineyard
  const poly = (pts, tags) =>
    elements.push({ type: 'way', id: id++, tags, geometry: pts.map(([lon, lat]) => ({ lon, lat })) });
  poly(
    [[9.912, 49.7865], [9.92, 49.7875], [9.9205, 49.794], [9.911, 49.7935], [9.912, 49.7865]],
    { landuse: 'forest' }
  );
  poly(
    [[9.94, 49.79], [9.947, 49.7905], [9.9465, 49.795], [9.9395, 49.7945], [9.94, 49.79]],
    { leisure: 'park' }
  );
  poly(
    [[9.909, 49.795], [9.918, 49.7955], [9.917, 49.801], [9.908, 49.8005], [9.909, 49.795]],
    { landuse: 'vineyard' }
  );

  return { elements };
}

// ---------------------------------------------------------------------------
// Serve dist + drive browser
// ---------------------------------------------------------------------------
const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {
  stdio: 'pipe',
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite preview timeout')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('4173')) {
      clearTimeout(t);
      resolve();
    }
  });
});

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1600,900',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn') console.log('[page]', m.type(), m.text());
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.setRequestInterception(true);
  const synthetic = JSON.stringify(syntheticOSM());
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('interpreter') || url.includes('overpass')) {
      req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: synthetic,
      });
    } else if (url.includes('fonts.g')) {
      req.respond({ status: 200, contentType: 'text/css', body: '' });
    } else {
      req.continue();
    }
  });

  await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__APP_READY === true', { timeout: 120000 });
  console.log('app ready');

  const settle = () => new Promise((r) => setTimeout(r, 4000));
  const setTime = async (v) => {
    await page.evaluate((val) => {
      const s = document.getElementById('time-slider');
      s.value = val;
      s.dispatchEvent(new Event('input'));
    }, v);
    await settle();
  };
  const teleport = async (args) => {
    await page.evaluate((a) => window.__teleport(...a), args);
    await settle();
  };
  const shoot = async (name) => {
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`${name}.png`);
  };

  // slider is minutes-of-day; the app boots at computed dusk
  const dusk = Number(await page.evaluate(() => document.getElementById('time-slider').value));
  console.log('dusk minutes:', dusk);

  // Vista: above the old town looking west to the fortress hill
  await teleport([480, 290, 420, -430, 110, 245]);
  await shoot('vista-dusk');
  await setTime(1415); // 23:35
  await shoot('vista-night');
  await setTime(850); // 14:10
  await shoot('vista-day');

  // Close-up over the synthetic Altstadt at dusk
  await setTime(dusk);
  await teleport([720, 190, 380, 300, 15, -120]);
  await shoot('city-dusk');

  // Street level near the river/bridge
  await teleport([120, 40, 180, -180, 12, 80]);
  await shoot('street-dusk');
} finally {
  await browser.close();
  server.kill();
}
console.log('done →', OUT);

import { MAP_BBOX, OSM_CACHE_KEY, OVERPASS_ENDPOINTS } from './config.js';
import { hash01 } from './geo.js';

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

function buildQuery() {
  const b = `${MAP_BBOX.south},${MAP_BBOX.west},${MAP_BBOX.north},${MAP_BBOX.east}`;
  return `[out:json][timeout:120];
(
  way["building"](${b});
  relation["building"](${b});
  way["highway"](${b});
  way["railway"~"^(rail|tram)$"](${b});
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["waterway"="riverbank"](${b});
  way["leisure"~"^(park|garden|pitch|playground)$"](${b});
  way["landuse"~"^(forest|grass|meadow|vineyard|cemetery|orchard|recreation_ground|village_green)$"](${b});
  way["natural"~"^(wood|scrub)$"](${b});
);
out tags geom;`;
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wuerzburg3d', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('osm');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const tx = db.transaction('osm', 'readonly').objectStore('osm').get(key);
      tx.onsuccess = () => resolve(tx.result ?? null);
      tx.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx = db.transaction('osm', 'readwrite').objectStore('osm').put(value, key);
      tx.onsuccess = resolve;
      tx.onerror = resolve;
    });
  } catch {
    /* cache is best-effort */
  }
}

export async function fetchOSM(onStatus = () => {}) {
  const cached = await idbGet(OSM_CACHE_KEY);
  if (cached) {
    onStatus('Stadtdaten aus lokalem Cache …');
    return cached;
  }
  const query = buildQuery();
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      onStatus(`Lade OpenStreetMap-Daten (${new URL(endpoint).host}) …`);
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.elements || json.elements.length < 100) throw new Error('Antwort unvollständig');
      idbSet(OSM_CACHE_KEY, json);
      return json;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Alle Overpass-Server fehlgeschlagen (${lastError?.message ?? 'unbekannt'})`);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function wayRing(way) {
  return way.geometry?.map((g) => [g.lon, g.lat]) ?? [];
}

function isClosed(ring) {
  if (ring.length < 4) return false;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

// Joins open way segments of a multipolygon into closed rings
function stitchRings(segments) {
  const rings = [];
  const open = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  while (open.length) {
    let ring = open.shift();
    let extended = true;
    while (!isClosed(ring) && extended) {
      extended = false;
      for (let i = 0; i < open.length; i++) {
        const seg = open[i];
        const tail = ring[ring.length - 1];
        const near = (p, q) => Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7;
        if (near(seg[0], tail)) {
          ring = ring.concat(seg.slice(1));
        } else if (near(seg[seg.length - 1], tail)) {
          ring = ring.concat(seg.slice(0, -1).reverse());
        } else {
          continue;
        }
        open.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (isClosed(ring) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function relationPolygons(rel) {
  const outers = [];
  const inners = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    const ring = m.geometry.map((g) => [g.lon, g.lat]);
    (m.role === 'inner' ? inners : outers).push(ring);
  }
  return { outers: stitchRings(outers), inners: stitchRings(inners) };
}

function parseHeightMeters(value) {
  if (!value) return null;
  const m = String(value).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

function buildingHeight(tags, id) {
  const h = parseHeightMeters(tags.height) ?? parseHeightMeters(tags['building:height']);
  if (h) return h;
  const levels = parseFloat(tags['building:levels']);
  if (!Number.isNaN(levels) && levels > 0) return levels * 3.3 + 1.5;
  const t = tags.building;
  if (t === 'church' || t === 'cathedral' || t === 'chapel') return 17;
  if (t === 'garage' || t === 'garages' || t === 'shed' || t === 'hut') return 3;
  if (t === 'house' || t === 'detached' || t === 'terrace') return 7.5 + hash01(id) * 2.5;
  if (t === 'apartments' || t === 'residential') return 12 + hash01(id) * 6;
  if (t === 'commercial' || t === 'retail' || t === 'office') return 13 + hash01(id) * 6;
  if (t === 'industrial' || t === 'warehouse') return 8;
  return 9 + hash01(id) * 7;
}

const ROAD_CLASSES = {
  motorway: { width: 11, rank: 0 },
  trunk: { width: 11, rank: 0 },
  primary: { width: 9.5, rank: 1 },
  secondary: { width: 8, rank: 1 },
  tertiary: { width: 7, rank: 2 },
  unclassified: { width: 5.5, rank: 3 },
  residential: { width: 5.5, rank: 3 },
  living_street: { width: 5, rank: 3 },
  pedestrian: { width: 4.5, rank: 4 },
  service: { width: 3.5, rank: 5 },
  track: { width: 2.5, rank: 6 },
  cycleway: { width: 2, rank: 6 },
  footway: { width: 2, rank: 6 },
  path: { width: 1.6, rank: 6 },
  steps: { width: 2, rank: 6 },
};

export function parseOSM(json) {
  const buildings = [];
  const roads = [];
  const rails = [];
  const waterPolys = [];
  const greens = [];

  for (const el of json.elements) {
    const tags = el.tags ?? {};

    if (el.type === 'way' && tags.building) {
      const ring = wayRing(el);
      if (ring.length >= 4) {
        buildings.push({
          id: el.id,
          outer: ring,
          holes: [],
          height: buildingHeight(tags, el.id),
          type: tags.building,
          name: tags.name ?? null,
        });
      }
      continue;
    }

    if (el.type === 'relation' && tags.building) {
      const { outers, inners } = relationPolygons(el);
      for (const outer of outers) {
        buildings.push({
          id: el.id,
          outer,
          holes: inners,
          height: buildingHeight(tags, el.id),
          type: tags.building,
          name: tags.name ?? null,
        });
      }
      continue;
    }

    if (el.type === 'way' && tags.highway) {
      const cls = ROAD_CLASSES[tags.highway];
      if (!cls) continue;
      const path = wayRing(el);
      if (path.length < 2) continue;
      roads.push({
        id: el.id,
        path,
        width: cls.width,
        rank: cls.rank,
        bridge: tags.bridge === 'yes' || tags.bridge === 'viaduct',
        tunnel: tags.tunnel === 'yes',
        name: tags.name ?? null,
      });
      continue;
    }

    if (el.type === 'way' && (tags.railway === 'rail' || tags.railway === 'tram')) {
      const path = wayRing(el);
      if (path.length >= 2) rails.push({ id: el.id, path, tram: tags.railway === 'tram' });
      continue;
    }

    const isWater = tags.natural === 'water' || tags.waterway === 'riverbank';
    if (isWater) {
      if (el.type === 'way') {
        const ring = wayRing(el);
        if (ring.length >= 4) waterPolys.push({ outer: ring, holes: [] });
      } else if (el.type === 'relation') {
        const { outers, inners } = relationPolygons(el);
        for (const outer of outers) waterPolys.push({ outer, holes: inners });
      }
      continue;
    }

    const greenKind =
      tags.landuse === 'vineyard' ? 'vineyard'
      : tags.landuse === 'forest' || tags.natural === 'wood' ? 'forest'
      : tags.landuse === 'cemetery' ? 'cemetery'
      : tags.leisure || tags.landuse || tags.natural ? 'green'
      : null;
    if (greenKind && el.type === 'way') {
      const ring = wayRing(el);
      if (ring.length >= 4) greens.push({ outer: ring, kind: greenKind, id: el.id });
    }
  }

  return { buildings, roads, rails, waterPolys, greens };
}

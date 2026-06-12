import { MAP_BBOX, OSM_CACHE_KEY, OVERPASS_ENDPOINTS } from './config.js';
import { hash01 } from './geo.js';

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

export function buildQuery() {
  const b = `${MAP_BBOX.south},${MAP_BBOX.west},${MAP_BBOX.north},${MAP_BBOX.east}`;
  return `[out:json][timeout:120];
(
  way["building"](${b});
  relation["building"](${b});
  way["building:part"](${b});
  relation["building:part"](${b});
  way["highway"](${b});
  way["railway"~"^(rail|tram)$"](${b});
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["waterway"="riverbank"](${b});
  relation["waterway"="riverbank"](${b});
  way["water"="river"](${b});
  relation["water"="river"](${b});
  way["waterway"~"^(river|canal)$"](${b});
  way["leisure"~"^(park|garden|pitch|playground)$"](${b});
  way["landuse"~"^(forest|grass|meadow|vineyard|cemetery|orchard|recreation_ground|village_green)$"](${b});
  way["natural"~"^(wood|scrub)$"](${b});
  way["place"="square"](${b});
  way["highway"~"^(pedestrian|footway)$"]["area"="yes"](${b});
  way["amenity"="parking"](${b});
  way["landuse"~"^(residential|commercial|retail|industrial|garages)$"](${b});
  relation["landuse"~"^(residential|commercial|retail|industrial|garages)$"](${b});
);
out geom;`;
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

// Joins way segments of a multipolygon into closed rings.
// Extends chains at both ends, snap-closes small data gaps and force-closes
// long leftover chains — incomplete data should degrade, not vanish.
function stitchRings(segments) {
  const rings = [];
  const open = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const near = (p, q, tol) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol;
  const TOL = 1e-7;
  while (open.length) {
    let ring = open.shift();
    let extended = true;
    while (!isClosed(ring) && extended) {
      extended = false;
      const tail = ring[ring.length - 1];
      const head = ring[0];
      for (let i = 0; i < open.length; i++) {
        const seg = open[i];
        if (near(seg[0], tail, TOL)) {
          ring = ring.concat(seg.slice(1));
        } else if (near(seg[seg.length - 1], tail, TOL)) {
          ring = ring.concat(seg.slice(0, -1).reverse());
        } else if (near(seg[seg.length - 1], head, TOL)) {
          ring = seg.slice(0, -1).concat(ring);
        } else if (near(seg[0], head, TOL)) {
          ring = seg.slice(1).reverse().concat(ring);
        } else {
          continue;
        }
        open.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length < 4) continue;
    if (!isClosed(ring) && near(ring[0], ring[ring.length - 1], 3e-5)) {
      ring.push([...ring[0]]); // snap-close gaps up to ~3 m
    }
    if (isClosed(ring)) {
      rings.push(ring);
    } else if (ring.length >= 8) {
      ring.push([...ring[0]]); // force-close: better a rough polygon than nothing
      rings.push(ring);
    }
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

function parseMinHeight(tags) {
  const m = parseHeightMeters(tags.min_height);
  if (m !== null) return m;
  const lv = parseFloat(tags['building:min_level']);
  if (!Number.isNaN(lv) && lv > 0) return lv * 3.3;
  return 0;
}

function roofInfo(tags) {
  const shape = tags['roof:shape'] ?? null;
  const height = parseHeightMeters(tags['roof:height']);
  return { shape, height };
}

export function parseOSM(json) {
  const buildings = [];
  const parts = [];
  const roads = [];
  const rails = [];
  const waterPolys = [];
  const riverLines = [];
  const greens = [];

  const pushBuilding = (list, el, outer, holes, typeTag) => {
    const tags = el.tags;
    list.push({
      id: el.id,
      outer,
      holes,
      height: buildingHeight(tags, el.id),
      minHeight: parseMinHeight(tags),
      roof: roofInfo(tags),
      type: typeTag,
      name: tags.name ?? null,
      wallColor: tags['building:colour'] ?? null,
      roofColor: tags['roof:colour'] ?? null,
    });
  };

  for (const el of json.elements) {
    const tags = el.tags ?? {};

    const isPart = tags['building:part'] && tags['building:part'] !== 'no';
    if (isPart || tags.building) {
      const list = isPart ? parts : buildings;
      const typeTag = isPart
        ? (tags['building:part'] === 'yes' ? tags.building ?? 'yes' : tags['building:part'])
        : tags.building;
      if (el.type === 'way') {
        const ring = wayRing(el);
        if (ring.length >= 4) pushBuilding(list, el, ring, [], typeTag);
      } else if (el.type === 'relation') {
        const { outers, inners } = relationPolygons(el);
        for (const outer of outers) pushBuilding(list, el, outer, inners, typeTag);
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

    // river/canal centerlines — fallback source if area polygons are missing
    if (el.type === 'way' && (tags.waterway === 'river' || tags.waterway === 'canal')) {
      const path = wayRing(el);
      if (path.length >= 2) {
        riverLines.push({
          path,
          width: parseHeightMeters(tags.width) ?? (tags.waterway === 'river' ? 75 : 28),
        });
      }
      continue;
    }

    const isWater =
      tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water === 'river';
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

    const URBAN_LANDUSE = ['residential', 'commercial', 'retail', 'industrial', 'garages'];
    const greenKind =
      tags.place === 'square' || ((tags.highway === 'pedestrian' || tags.highway === 'footway') && tags.area === 'yes') ? 'plaza'
      : tags.amenity === 'parking' ? 'parking'
      : tags.landuse === 'vineyard' ? 'vineyard'
      : tags.landuse === 'forest' || tags.natural === 'wood' ? 'forest'
      : tags.landuse === 'cemetery' ? 'cemetery'
      : URBAN_LANDUSE.includes(tags.landuse) ? 'urban'
      : tags.leisure || tags.landuse || tags.natural ? 'green'
      : null;
    if (greenKind) {
      if (el.type === 'way') {
        const ring = wayRing(el);
        if (ring.length >= 4) greens.push({ outer: ring, kind: greenKind, id: el.id });
      } else if (el.type === 'relation') {
        const { outers } = relationPolygons(el);
        for (const outer of outers) greens.push({ outer, kind: greenKind, id: el.id });
      }
    }
  }

  // Simple-3D buildings: a hull that is detailed by parts is not rendered itself.
  // Safety net: only hide the hull when its parts actually cover a substantial
  // share of its footprint — if parts are broken/missing, the hull stays visible.
  if (parts.length) {
    const inRing = (lon, lat, ring) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    };
    // area in m² (equirectangular approximation is fine at city scale)
    const ringAreaM2 = (ring) => {
      const mLat = 111194;
      const mLon = 111319.49 * Math.cos((ring[0][1] * Math.PI) / 180);
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        a += x1 * mLon * (y2 * mLat) - x2 * mLon * (y1 * mLat);
      }
      return Math.abs(a / 2);
    };
    const partInfo = parts.map((p) => {
      let lon = 0;
      let lat = 0;
      for (const [x, y] of p.outer) {
        lon += x;
        lat += y;
      }
      return {
        lon: lon / p.outer.length,
        lat: lat / p.outer.length,
        area: ringAreaM2(p.outer),
      };
    });
    for (const b of buildings) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const [x, y] of b.outer) {
        minLon = Math.min(minLon, x); maxLon = Math.max(maxLon, x);
        minLat = Math.min(minLat, y); maxLat = Math.max(maxLat, y);
      }
      let covered = 0;
      for (const pi of partInfo) {
        if (pi.lon < minLon || pi.lon > maxLon || pi.lat < minLat || pi.lat > maxLat) continue;
        if (inRing(pi.lon, pi.lat, b.outer)) covered += pi.area;
      }
      b.hasParts = covered >= ringAreaM2(b.outer) * 0.25;
    }
  }

  return { buildings, parts, roads, rails, waterPolys, riverLines, greens };
}

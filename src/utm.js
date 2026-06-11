// UTM zone 32 (EPSG:25832) <-> WGS84 — standard transverse Mercator series.
// Shared by the runtime (DGM1 terrain sampling) and the bake tools.
const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const LON0 = (9 * Math.PI) / 180; // zone 32 central meridian

export function utmToLonLat(easting, northing) {
  const x = easting - 500000;
  const m = northing / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const n1 = A / Math.sqrt(1 - E2 * sin1 * sin1);
  const t1 = tan1 * tan1;
  const c1 = EP2 * cos1 * cos1;
  const r1 = (A * (1 - E2)) / Math.pow(1 - E2 * sin1 * sin1, 1.5);
  const d = x / (n1 * K0);

  const lat =
    phi1 -
    ((n1 * tan1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720);
  const lon =
    LON0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) /
      cos1;
  return { lon: (lon * 180) / Math.PI, lat: (lat * 180) / Math.PI };
}

export function lonLatToUtm(lonDeg, latDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sinp = Math.sin(lat);
  const cosp = Math.cos(lat);
  const tanp = Math.tan(lat);
  const n = A / Math.sqrt(1 - E2 * sinp * sinp);
  const t = tanp * tanp;
  const c = EP2 * cosp * cosp;
  const a1 = cosp * (lon - LON0);
  const m =
    A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256) * lat -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * lat) +
      ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * lat) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * lat));
  const easting =
    K0 * n * (a1 + ((1 - t + c) * a1 ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a1 ** 5) / 120) +
    500000;
  const northing =
    K0 *
    (m +
      n * tanp * ((a1 * a1) / 2 + ((5 - t + 9 * c + 4 * c * c) * a1 ** 4) / 24 +
        ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a1 ** 6) / 720));
  return { easting, northing };
}

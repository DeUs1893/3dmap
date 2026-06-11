// Solar position (NOAA low-precision formulas, good to ~0.1°)
// Returns azimuth in degrees from north (clockwise) and elevation in degrees.
export function sunPosition(date, latDeg, lonDeg) {
  const rad = Math.PI / 180;
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000; // days since J2000

  const L = (280.46 + 0.9856474 * d) % 360; // mean longitude
  const g = (357.528 + 0.9856003 * d) * rad; // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * d) * rad; // obliquity

  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)); // right ascension
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)); // declination

  // local sidereal time → hour angle
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = (gmst * 15 + lonDeg) * rad;
  let H = lst - ra;
  // normalize to [-PI, PI]
  H = ((H + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  const lat = latDeg * rad;
  const elevation = Math.asin(
    Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H)
  );
  // azimuth measured from south, westward positive → convert to from-north clockwise
  const azSouth = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)
  );
  const azimuth = ((azSouth / rad + 180) % 360 + 360) % 360;

  return { azimuth, elevation: elevation / rad };
}

// Date object for "today at N minutes after local midnight"
export function dateAtMinutes(minutes) {
  const d = new Date();
  d.setHours(0, Math.round(minutes), 0, 0);
  return d;
}

// A pleasant default: ~20 minutes before sunset (fallback: 19:00)
export function findDuskMinutes(latDeg, lonDeg) {
  for (let m = 11 * 60; m < 24 * 60; m += 5) {
    const { elevation } = sunPosition(dateAtMinutes(m), latDeg, lonDeg);
    if (elevation < 4) return Math.max(0, m - 20);
  }
  return 19 * 60;
}

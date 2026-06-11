// Geographic extent of the map (Würzburg Altstadt, Festung Marienberg, Residenz, Käppele, Hauptbahnhof)
export const MAP_BBOX = {
  south: 49.778,
  west: 9.898,
  north: 49.807,
  east: 9.957,
};

export const ORIGIN = {
  lat: (MAP_BBOX.south + MAP_BBOX.north) / 2,
  lon: (MAP_BBOX.west + MAP_BBOX.east) / 2,
};

// Elevation subtracted from all heights so the scene sits near y=0 (Main valley ≈ 166 m)
export const BASE_ELEVATION = 166;

// Extra terrain rendered beyond the data bbox so the map doesn't end abruptly
export const TERRAIN_MARGIN = 650; // meters

// Version string for the IndexedDB cache of OSM data — bump to force a refetch
export const OSM_CACHE_KEY = 'wuerzburg-osm-v2';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Notable places: camera targets, floodlighting and labels
export const LANDMARKS = [
  { id: 'festung', name: 'Festung Marienberg', lon: 9.9215, lat: 49.7903, labelHeight: 42, floodRadius: 150, viewDistance: 520, desc: 'Wahrzeichen über dem Main, ab 1201 erbaut' },
  { id: 'residenz', name: 'Würzburger Residenz', lon: 9.9394, lat: 49.7926, labelHeight: 32, floodRadius: 110, viewDistance: 420, desc: 'UNESCO-Welterbe, Balthasar Neumann 1720–1744' },
  { id: 'dom', name: 'Dom St. Kilian', lon: 9.9320, lat: 49.7928, labelHeight: 48, floodRadius: 60, viewDistance: 340, desc: 'Romanischer Dom, geweiht 1188' },
  { id: 'bruecke', name: 'Alte Mainbrücke', lon: 9.9258, lat: 49.7933, labelHeight: 16, floodRadius: 45, viewDistance: 300, desc: 'Brückenheilige & Brückenschoppen seit 1543' },
  { id: 'kaeppele', name: 'Käppele', lon: 9.9166, lat: 49.7858, labelHeight: 30, floodRadius: 55, viewDistance: 380, desc: 'Wallfahrtskirche von Balthasar Neumann' },
  { id: 'marienkapelle', name: 'Marienkapelle', lon: 9.9286, lat: 49.7942, labelHeight: 42, floodRadius: 45, viewDistance: 280, desc: 'Gotische Kirche am Marktplatz' },
  { id: 'rathaus', name: 'Rathaus · Grafeneckart', lon: 9.9292, lat: 49.7935, labelHeight: 30, floodRadius: 40, viewDistance: 260, desc: 'Ältester Teil um 1200' },
  { id: 'neumuenster', name: 'Neumünster', lon: 9.9308, lat: 49.7930, labelHeight: 36, floodRadius: 40, viewDistance: 260, desc: 'Barockfassade über dem Kiliansgrab' },
  { id: 'haug', name: 'Stift Haug', lon: 9.9353, lat: 49.7964, labelHeight: 40, floodRadius: 50, viewDistance: 300, desc: 'Erste Barockkirche Frankens' },
  { id: 'kranen', name: 'Alter Kranen', lon: 9.9274, lat: 49.7968, labelHeight: 14, floodRadius: 30, viewDistance: 240, desc: 'Hafenkran von 1773 am Mainufer' },
  { id: 'hbf', name: 'Hauptbahnhof', lon: 9.9358, lat: 49.8018, labelHeight: 18, floodRadius: 70, viewDistance: 360, desc: 'Tor zur Stadt seit 1854' },
];

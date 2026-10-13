// --- Sehenswürdigkeiten in der Nähe (Wikidata) ----------------------------
// Lädt abhängig von der aktuellen Flugposition Orte aus Wikidata (Brücken,
// Kirchen, Plätze, Parks, Industrie, Hochhäuser, ...) und zeigt als Hinweis
// die bekannteste Sehenswürdigkeit in der Nähe samt Entfernung und Richtung.
//
// Ablauf:
//  1. Die Welt ist in Zellen von CELL_DEG Grad eingeteilt. Für die Zelle unter
//     der Kamera (und die Zelle in Flugrichtung, als Vorab-Laden) wird eine
//     SPARQL-Abfrage an query.wikidata.org gestellt (wikibase:around, Radius
//     FETCH_RADIUS_KM). Wikidata erlaubt CORS - kein Proxy, kein API-Key nötig.
//  2. "Groß genug für die 3D Tiles" wird über zwei Dinge angenähert:
//     Bekanntheit (Anzahl Wikipedia-Sprachversionen = wikibase:sitelinks) und,
//     wo Wikidata Maße kennt, Mindesthöhe/-länge/-fläche (siehe CATEGORIES).
//  3. Das Ergebnis je Zelle wird in localStorage zwischengespeichert.
//  4. update() wird pro Frame aus dem Tick-Handler gerufen und wählt das Ziel.

const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
const CELL_DEG = 0.1; // ca. 11 km
const FETCH_RADIUS_KM = 20; // Zellmitte + halbe Zelle (~8 km) + NEARBY_RADIUS_M (10 km)
const AHEAD_PREFETCH_M = 12000; // Zelle in Flugrichtung vorab laden
const QUERY_TIMEOUT_MS = 55000; // Wikidata bricht serverseitig bei 60 s ab
const FALLBACK_TIMEOUT_MS = 40000;
const FALLBACK_RADIUS_KM = 13; // knapp über Zellhälfte + NEARBY_RADIUS_M
const FALLBACK_EXTRA_SITELINKS = 4; // leichte Abfrage: nur bekanntere Orte
const QUERY_LIMIT = 1500;
const RETRY_AFTER_FAILURE_MS = 60000;
const MIN_REQUEST_GAP_MS = 2500; // Mindestabstand zwischen zwei Wikidata-Abfragen
const DEFAULT_RATE_LIMIT_PAUSE_MS = 60000; // Pause bei 429 ohne Retry-After-Header
const MAX_RATE_LIMIT_PAUSE_MS = 300000;

// Gemeinsamer Zustand: Wikidata begrenzt die gesamte Rechenzeit pro Client.
// Nach einem 429 pausiert jede weitere Abfrage, bis die Sperre abgelaufen ist.
let rateLimitedUntil = 0;
let lastRequestEndedAt = 0;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ENABLED_KEY = "flymaps_discovery_enabled";

const NEARBY_RADIUS_M = 10000;
const ARRIVED_RADIUS_M = 100; // Pin erscheint und Ort gilt als besucht
const ARRIVED_PIN_PATH = "M12 2a8 8 0 0 0-8 8c0 5 8 12 8 12s8-7 8-12a8 8 0 0 0-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z";
const KEEP_RADIUS_FACTOR = 1.3;
const EVALUATE_INTERVAL_MS = 1000;
const ARROW_INTERVAL_MS = 100;
const AUTO_ADVANCE_MS = 4000; // so lange nach der Ankunft, dann kommt das nächste Ziel
const CELL_CHECK_INTERVAL_MS = 1500;

// Stadt-Modus: Befinden sich mindestens CITY_MIN_POIS Nicht-Natur-Ziele im
// Umkreis CITY_RADIUS_M, gilt die Position als "in der Stadt". Dann werden
// Berge in der Reihenfolge nach hinten geschoben: ihre Entfernung zählt für die
// Sortierung MOUNTAIN_CITY_PENALTY-fach (Innsbruck: erst die Stadt, dann die
// Nordkette). Berge bleiben erreichbar (X/Z), nur eben weiter hinten.
const NATURE_CATEGORY_IDS = new Set([
  "volcano", "mountain", "waterfall", "canyon", "glacier", "geyser",
  "natpark", "lake", "island", "beach", "cave", "desert",
]);
const DEPRIORITIZED_IN_CITY_IDS = new Set(["mountain"]);
const CITY_RADIUS_M = 4000;
const CITY_MIN_POIS = 3;
const MOUNTAIN_CITY_PENALTY = 4;

// Kategorien. Reihenfolge = Priorität, falls ein Ort zu mehreren passt
// (spezifischer zuerst). minSitelinks filtert nach Bekanntheit; die
// Größenangaben greifen nur, wenn Wikidata einen Wert kennt - Orte ohne
// Maßangabe bleiben bei ausreichender Bekanntheit erhalten.
// Höhe/Länge in Metern, Fläche in m².
//
// expand: true - matcht auch Unterklassen (P279*) der angegebenen Klasse,
// nicht nur direkte P31-Treffer. Nötig bei Naturobjekten: der Fuji z.B. ist
// nicht direkt als "Vulkan" (Q8072) klassifiziert, sondern nur über Unter-
// klassen wie "aktiver Vulkan"/"Stratovulkan". Die einzelnen Unterklassen
// aufzuzählen ist unzuverlässig (davon gibt es sehr viele: Schildvulkan,
// Caldera, Lavadom, ...), daher hier die Hierarchie auflösen statt sie
// aufzuzählen. Bewusst nur für diese wenigen Naturkategorien, nicht global
// (siehe Performance-Hinweis bei buildQuery) - sonst wird die Abfrage für
// alle ~30 Kategorien teuer.
const CATEGORIES = [
  // --- Sakral ---
  { id: "cathedral", label: "Kathedrale", classes: ["Q2977"], minSitelinks: 6 },
  // expand: Dom, Hallenkirche, Pfarrkirche usw. sind in Wikidata oft nur Unterklassen von "Kirchengebäude".
  { id: "church", label: "Kirche", classes: ["Q16970"], minSitelinks: 7, expand: true },
  { id: "mosque", label: "Moschee", classes: ["Q32815"], minSitelinks: 6 },
  { id: "synagogue", label: "Synagoge", classes: ["Q34627"], minSitelinks: 6 },
  { id: "temple", label: "Tempel", classes: ["Q44539"], minSitelinks: 6 },
  { id: "abbey", label: "Kloster / Abtei", classes: ["Q160742", "Q44613"], minSitelinks: 4 },
  // --- Burgen, Archäologie ---
  { id: "castle", label: "Burg", classes: ["Q23413"], minSitelinks: 2 },
  { id: "palace", label: "Schloss", classes: ["Q16560"], minSitelinks: 2 },
  { id: "fortification", label: "Festung", classes: ["Q57821"], minSitelinks: 2 },
  { id: "ruin", label: "Ruine", classes: ["Q109607"], minSitelinks: 3 },
  { id: "pyramid", label: "Pyramide", classes: ["Q12516"], minSitelinks: 2 },
  { id: "archaeo", label: "Archäologische Stätte", classes: ["Q839954"], minSitelinks: 3 },
  // --- Bauwerke / Technik ---
  { id: "bridge", label: "Brücke", classes: ["Q12280"], minSitelinks: 8, minLength: 200 },
  { id: "dam", label: "Staumauer", classes: ["Q12323"], minSitelinks: 4 },
  { id: "reservoir", label: "Stausee", classes: ["Q131681"], minSitelinks: 5 },
  { id: "canal", label: "Kanal", classes: ["Q12284"], minSitelinks: 6 },
  { id: "skyscraper", label: "Hochhaus", classes: ["Q11303"], minSitelinks: 5, minHeight: 100 },
  { id: "obstower", label: "Aussichtsturm", classes: ["Q1440300"], minSitelinks: 4 },
  { id: "tower", label: "Turm", classes: ["Q12518"], minSitelinks: 5, minHeight: 10 },
  { id: "lighthouse", label: "Leuchtturm", classes: ["Q39715"], minSitelinks: 6 },
  { id: "windmill", label: "Windmühle", classes: ["Q38720"], minSitelinks: 4 },
  { id: "stadium", label: "Stadion", classes: ["Q483110"], minSitelinks: 6 },
  { id: "opera", label: "Opernhaus", classes: ["Q153562"], minSitelinks: 5 },
  // Q3918 = Universität, Q875538 = staatliche Universität (viele Hochschulen sind nur so erfasst).
  // Der Wikidata-Punkt liegt oft am Hauptcampus/Verwaltungsgebäude.
  { id: "university", label: "Universität", classes: ["Q3918", "Q875538"], minSitelinks: 3 },
  { id: "theatre", label: "Theater", classes: ["Q24354"], minSitelinks: 5 },
  // Museen sind sehr zahlreich - Schwelle bewusst höher, sonst fluten sie Großstädte.
  { id: "museum", label: "Museum", classes: ["Q33506"], minSitelinks: 6 },
  { id: "cityhall", label: "Rathaus", classes: ["Q543654"], minSitelinks: 2 },
  // --- Denkmäler ---
  { id: "warmemorial", label: "Kriegerdenkmal", classes: ["Q575759"], minSitelinks: 6 },
  { id: "memorial", label: "Gedenkstätte", classes: ["Q5003624"], minSitelinks: 8 },
  { id: "citywall", label: "Stadtmauer / Stadttor", classes: ["Q16748868", "Q82117"], minSitelinks: 3 },
  { id: "fountain", label: "Brunnen", classes: ["Q483453"], minSitelinks: 5 },
  { id: "statue", label: "Statue", classes: ["Q179700"], minSitelinks: 10 },
  { id: "monument", label: "Denkmal", classes: ["Q4989906"], minSitelinks: 12 },
  // --- Plätze, Parks, Freizeit ---
  // Q330284 = Marktplatz (z.B. Hauptmarkt); viele Marktplätze sind nicht als "Platz" erfasst.
  { id: "square", label: "Platz", classes: ["Q174782", "Q330284"], minSitelinks: 3 },
  { id: "park", label: "Park", classes: ["Q22698"], minSitelinks: 4, minArea: 100000 },
  { id: "garden", label: "Garten", classes: ["Q167346", "Q1107656"], minSitelinks: 4 },
  { id: "amusement", label: "Freizeitpark", classes: ["Q194195"], minSitelinks: 4 },
  { id: "zoo", label: "Zoo", classes: ["Q43501"], minSitelinks: 4 },
  // --- Industrie, Verkehr ---
  // power mit expand: schließt Atom-, Wasser-, Kohlekraftwerke etc. über Unterklassen ein.
  { id: "power", label: "Kraftwerk", classes: ["Q159719"], minSitelinks: 5, expand: true },
  { id: "windfarm", label: "Windpark", classes: ["Q194356"], minSitelinks: 4 },
  { id: "factory", label: "Industrieanlage", classes: ["Q83405"], minSitelinks: 6 },
  // Q8148: Orte, die direkt als "Industrie" erfasst sind (ohne expand - nur direkte P31-Treffer).
  { id: "industry", label: "Industrie", classes: ["Q8148"], minSitelinks: 3 },
  { id: "mine", label: "Bergwerk", classes: ["Q820477"], minSitelinks: 6 },
  { id: "port", label: "Hafen", classes: ["Q44782"], minSitelinks: 6 },
  { id: "airport", label: "Flughafen", classes: ["Q1248784"], minSitelinks: 8 },
  { id: "station", label: "Bahnhof", classes: ["Q55488"], minSitelinks: 5 },
  // --- Natur ---
  {
    id: "volcano",
    label: "Vulkan",
    classes: ["Q8072"], // Vulkan (deckt per P279* auch Stratovulkan, aktiver Vulkan, ... ab)
    minSitelinks: 6,
    expand: true,
  },
  // Berg: bekannt (>= strongSitelinks) ODER hoch (>= minElevation m, P2044)
  // und wenigstens minSitelinks. Orte ohne Höhenangabe zählen nur über Bekanntheit.
  {
    id: "mountain",
    label: "Berg",
    classes: ["Q8502"],
    minSitelinks: 2,
    strongSitelinks: 6,
    minElevation: 50,
    expand: true,
  },
  { id: "waterfall", label: "Wasserfall", classes: ["Q34038"], minSitelinks: 6, expand: true },
  // ACHTUNG: vorher Q179049 - das ist vermutlich "Naturschutzgebiet", nicht Canyon. Bitte prüfen.
  { id: "canyon", label: "Canyon", classes: ["Q150784"], minSitelinks: 4, expand: true },
  { id: "glacier", label: "Gletscher", classes: ["Q35666"], minSitelinks: 4, expand: true },
  { id: "geyser", label: "Geysir", classes: ["Q1420294"], minSitelinks: 3, expand: true },
  { id: "natpark", label: "Nationalpark", classes: ["Q46169"], minSitelinks: 4 },
  { id: "lake", label: "See", classes: ["Q23397"], minSitelinks: 8 }, // bewusst ohne expand: P279* ist teuer
  { id: "island", label: "Insel", classes: ["Q23442"], minSitelinks: 8 },
  { id: "beach", label: "Strand", classes: ["Q40080"], minSitelinks: 6 },
  { id: "cave", label: "Höhle", classes: ["Q35509"], minSitelinks: 5 },
  { id: "desert", label: "Wüste", classes: ["Q8514"], minSitelinks: 8 },
  // --- Auffänger (bewusst zuletzt: spezifischere Kategorien gewinnen per Math.min) ---
  { id: "attraction", label: "Sehenswürdigkeit", classes: ["Q570116"], minSitelinks: 5 },
];

// UNESCO-Welterbe: klassenunabhängig über P1435 (Schutzstatus). Wird in
// buildQuery als eigener UNION-Zweig abgefragt und landet in der Kategorie "unesco".
const HERITAGE_CLASS = "Q9259";
CATEGORIES.push({
  id: "unesco",
  label: "UNESCO-Welterbe",
  classes: [HERITAGE_CLASS],
  minSitelinks: 5,
  heritage: true,
});

// Cache-Schlüssel automatisch aus der Konfiguration ableiten: Die Filter
// (minSitelinks, minHeight, ...) werden schon beim Speichern einer Zelle
// angewendet. Ändert sich CATEGORIES oder ein Abfrage-Parameter, ändert sich
// der Hash, und alle alten Zellen werden neu geladen - ohne manuelles
// Hochzählen einer Versionsnummer. Alte Einträge werden beim Start gelöscht.
const CACHE_BASE = "flymaps_poi_cell_";
const CACHE_PREFIX =
  CACHE_BASE +
  (() => {
    const text = JSON.stringify([
      CATEGORIES,
      FETCH_RADIUS_KM,
      FALLBACK_RADIUS_KM,
      FALLBACK_EXTRA_SITELINKS,
      QUERY_LIMIT,
    ]);
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    }
    return "h" + h.toString(36);
  })() +
  "_";

try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (
      key &&
      key.startsWith(CACHE_BASE) &&
      !key.startsWith(CACHE_PREFIX)
    ) {
      localStorage.removeItem(key);
    }
  }
} catch {
  // kein localStorage - dann gibt es auch keinen Cache
}

const CATEGORY_INDEX_BY_CLASS = new Map();

CATEGORIES.forEach((category, index) => {
  for (const qid of category.classes) {
    CATEGORY_INDEX_BY_CLASS.set(qid, index);
  }
});

const GLOBAL_MIN_SITELINKS = Math.min(
  ...CATEGORIES.map((c) => c.minSitelinks)
);

// Performance:
// Für die meisten Kategorien (Gebäude/Bauwerke) wird weiterhin nur die
// direkte P31-Klasse abgefragt - keine globale P279*-Klassenhierarchie,
// das wäre für ~25 Kategorien extrem teuer. Für die wenigen Naturkategorien
// (expand: true) wird gezielt per P31/P279* auch über Unterklassen gesucht,
// da Naturobjekte in Wikidata oft nur über Unterklassen erfasst sind (siehe
// Kommentar bei CATEGORIES).
function buildQuery(lat, lon, radiusKm, minSitelinks) {
  const directValues = CATEGORIES.filter((c) => !c.expand && !c.heritage)
    .flatMap((c) => c.classes)
    .map((q) => `wd:${q}`)
    .join(" ");

  const expandValues = CATEGORIES.filter((c) => c.expand && !c.heritage)
    .flatMap((c) => c.classes)
    .map((q) => `wd:${q}`)
    .join(" ");

  return `
SELECT ?item ?coord ?sitelinks ?cat ?de ?en ?area ?height ?length ?elevation WHERE {

  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .

    bd:serviceParam
      wikibase:center
      "Point(${lon} ${lat})"^^geo:wktLiteral .

    bd:serviceParam
      wikibase:radius
      "${radiusKm}" .
  }

  {
    ?item wdt:P31 ?cat .
    VALUES ?cat { ${directValues} }
  }
  UNION
  {
    ?item wdt:P31/wdt:P279* ?cat .
    VALUES ?cat { ${expandValues} }
  }
  UNION
  {
    ?item wdt:P1435 ?cat .
    VALUES ?cat { wd:${HERITAGE_CLASS} }
  }

  ?item wikibase:sitelinks ?sitelinks .

  FILTER(?sitelinks >= ${minSitelinks})

  OPTIONAL {
    ?item rdfs:label ?de .
    FILTER(LANG(?de) = "de")
  }

  OPTIONAL {
    ?item rdfs:label ?en .
    FILTER(LANG(?en) = "en")
  }

  OPTIONAL {
    ?item p:P2046/psn:P2046/wikibase:quantityAmount ?area
  }

  OPTIONAL {
    ?item p:P2048/psn:P2048/wikibase:quantityAmount ?height
  }

  OPTIONAL {
    ?item p:P2043/psn:P2043/wikibase:quantityAmount ?length
  }

  OPTIONAL {
    ?item p:P2044/psn:P2044/wikibase:quantityAmount ?elevation
  }
}
LIMIT ${QUERY_LIMIT}`;
}

function lastSegment(url) {
  return url.slice(url.lastIndexOf("/") + 1);
}

function numberOrNull(binding) {
  if (!binding) return null;

  const n = Number(binding.value);

  return Number.isFinite(n) ? n : null;
}

// Rohzeilen (mehrere pro Ort wegen Kategorien/Labels) zu einem Ort je Item
// zusammenfassen und anschließend nach Bekanntheit/Größe filtern.
function rowsToPois(rows) {
  const byId = new Map();

  for (const row of rows) {
    const id = lastSegment(row.item.value);

    const match = /Point\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)/
      .exec(row.coord?.value ?? "");

    if (!match) continue;

    const categoryIndex = CATEGORY_INDEX_BY_CLASS.get(
      lastSegment(row.cat.value)
    );

    if (categoryIndex === undefined) continue;

    let poi = byId.get(id);

    if (!poi) {
      poi = {
        id,
        name: row.de?.value ?? row.en?.value ?? null,

        lon: Number(match[1]),
        lat: Number(match[2]),

        sl: numberOrNull(row.sitelinks) ?? 0,

        cat: categoryIndex,

        area: numberOrNull(row.area),
        height: numberOrNull(row.height),
        length: numberOrNull(row.length),
        elevation: numberOrNull(row.elevation),
      };

      byId.set(id, poi);
    } else {
      poi.cat = Math.min(poi.cat, categoryIndex);

      poi.name ??=
        row.de?.value ??
        row.en?.value ??
        null;

      poi.area ??= numberOrNull(row.area);
      poi.height ??= numberOrNull(row.height);
      poi.length ??= numberOrNull(row.length);
      poi.elevation ??= numberOrNull(row.elevation);
    }
  }

  const result = [];
  const dropped = [];

  const drop = (poi, grund) =>
    dropped.push({
      name: poi.name ?? `(ohne de/en-Label) ${poi.id}`,
      kategorie: CATEGORIES[poi.cat].label,
      sitelinks: poi.sl,
      grund,
      id: poi.id,
    });

  for (const poi of byId.values()) {
    if (!poi.name || /^Q\d+$/.test(poi.name)) {
      drop(poi, "kein deutsches/englisches Label");
      continue;
    }

    const category = CATEGORIES[poi.cat];

    if (poi.sl < category.minSitelinks) {
      drop(
        poi,
        `zu wenig Sitelinks (${poi.sl} < ${category.minSitelinks})`
      );
      continue;
    }

    // Berge: bekannt genug ODER hoch genug (nur wenn Höhe bekannt).
    if (category.strongSitelinks && poi.sl < category.strongSitelinks) {
      if (
        poi.elevation === null ||
        poi.elevation < (category.minElevation ?? Infinity)
      ) {
        drop(poi, "Berg: zu unbekannt bzw. zu niedrig");
        continue;
      }
    }

    if (
      category.minHeight &&
      poi.height !== null &&
      poi.height < category.minHeight
    ) {
      drop(poi, `zu niedrig (${poi.height} m < ${category.minHeight} m)`);
      continue;
    }

    if (
      category.minLength &&
      poi.length !== null &&
      poi.length < category.minLength
    ) {
      drop(poi, `zu kurz (${poi.length} m < ${category.minLength} m)`);
      continue;
    }

    if (
      category.minArea &&
      poi.area !== null &&
      poi.area < category.minArea
    ) {
      drop(poi, `zu klein (${Math.round(poi.area)} m² < ${category.minArea} m²)`);
      continue;
    }

    result.push({
      id: poi.id,
      name: poi.name,
      lat: poi.lat,
      lon: poi.lon,
      sl: poi.sl,
      cat: poi.cat,
    });
  }

  // Diagnose: zeigt, was die Filter aus den Wikidata-Treffern entfernt haben.
  // Kirchen und Bahnhöfe (Massenware) stehen am Ende, damit seltenere
  // Kategorien nicht aus der Tabelle herausfallen.
  if (dropped.length > 0) {
    const bulk = new Set(["Kirche", "Bahnhof"]);
    dropped.sort(
      (x, y) =>
        Number(bulk.has(x.kategorie)) - Number(bulk.has(y.kategorie)) ||
        y.sitelinks - x.sitelinks
    );
    console.groupCollapsed(
      `[Discovery] Aussortiert: ${dropped.length} von ${byId.size} Treffern`
    );
    console.table(dropped.slice(0, 200));
    console.groupEnd();
  }

  return result;
}

async function runQuery(
  lat,
  lon,
  radiusKm,
  minSitelinks,
  timeoutMs
) {
  const params = new URLSearchParams({
    query: buildQuery(
      lat,
      lon,
      radiusKm,
      minSitelinks
    ),
    format: "json",
  });

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  const started = performance.now();

  try {
    const response = await fetch(
      `${WIKIDATA_ENDPOINT}?${params}`,
      {
        signal: controller.signal,
      }
    );

    if (response.status === 429 || response.status === 503) {
      const header = Number(response.headers.get("Retry-After"));
      const pause = Number.isFinite(header) && header > 0
        ? header * 1000
        : DEFAULT_RATE_LIMIT_PAUSE_MS;
      const err = new Error(
        `Wikidata antwortet mit ${response.status} (Rate-Limit)`
      );
      err.name = "RateLimitError";
      err.pauseMs = Math.min(pause, MAX_RATE_LIMIT_PAUSE_MS);
      throw err;
    }

    if (!response.ok) {
      throw new Error(
        `Wikidata antwortet mit ${response.status}`
      );
    }

    const data = await response.json();

    const rows = data.results.bindings;

    const result = rowsToPois(rows);

    console.info(
      `[Discovery] ${rows.length} Zeilen -> ${result.length} Orte ` +
      `(${radiusKm} km, ` +
      `${((performance.now() - started) / 1000).toFixed(1)} s)`
    );

    if (rows.length >= QUERY_LIMIT) {
      console.warn(
        `[Discovery] LIMIT ${QUERY_LIMIT} erreicht - ` +
        `Ergebnis evtl. unvollständig`
      );
    }

    return result;
  } finally {
    clearTimeout(timeout);
    lastRequestEndedAt = performance.now();
  }
}

// Erst die normale Abfrage.
// Falls Wikidata trotzdem in den Timeout läuft, wird eine
// kleinere Abfrage mit höherer Mindestbekanntheit versucht.
async function fetchCellFromWikidata(lat, lon) {
  try {
    return await runQuery(
      lat,
      lon,
      FETCH_RADIUS_KM,
      GLOBAL_MIN_SITELINKS,
      QUERY_TIMEOUT_MS
    );
  } catch (err) {
    if (err?.name !== "AbortError") {
      throw err;
    }

    console.warn(
      "[Discovery] Timeout, versuche leichtere Abfrage ..."
    );

    return await runQuery(
      lat,
      lon,
      FALLBACK_RADIUS_KM,
      GLOBAL_MIN_SITELINKS + FALLBACK_EXTRA_SITELINKS,
      FALLBACK_TIMEOUT_MS
    );
  }
}

function readCellCache(key) {
  try {
    const raw = localStorage.getItem(
      CACHE_PREFIX + key
    );

    if (!raw) {
      return null;
    }

    const entry = JSON.parse(raw);

    if (
      !entry ||
      Date.now() - entry.t > CACHE_TTL_MS ||
      !Array.isArray(entry.pois)
    ) {
      return null;
    }

    return entry.pois;
  } catch {
    return null;
  }
}

function writeCellCache(key, pois) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + key,
      JSON.stringify({
        t: Date.now(),
        pois,
      })
    );
  } catch {
    // Speicher voll oder nicht verfügbar -
    // dann eben ohne Cache.
  }
}

// --- Geometrie ---------------------------------------------------------------

const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON_EQUATOR = 111320;

// Lokale Ebene (Ost/Nord in Metern) - für wenige Kilometer genau genug.
function offsetMeters(
  fromLat,
  fromLon,
  toLat,
  toLon
) {
  const east =
    (toLon - fromLon) *
    METERS_PER_DEG_LON_EQUATOR *
    Math.cos(
      (fromLat * Math.PI) / 180
    );

  const north =
    (toLat - fromLat) *
    METERS_PER_DEG_LAT;

  return {
    east,
    north,
  };
}

function cellOf(lat, lon) {
  const row = Math.floor(
    lat / CELL_DEG
  );

  const col = Math.floor(
    lon / CELL_DEG
  );

  return {
    key: `${row}_${col}`,

    lat:
      (row + 0.5) *
      CELL_DEG,

    lon:
      (col + 0.5) *
      CELL_DEG,
  };
}

function normalizeDegrees(deg) {
  let d = deg % 360;

  if (d > 180) {
    d -= 360;
  }

  if (d <= -180) {
    d += 360;
  }

  return d;
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.max(
      50,
      Math.round(meters / 50) * 50
    )} m`;
  }

  return `${(
    meters / 1000
  ).toLocaleString("de-DE", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })} km`;
}

// --- Modul -------------------------------------------------------------------

export function initDiscovery() {
  const hintEl =
    document.getElementById(
      "discovery-hint"
    );

  const arrowEl =
    document.getElementById(
      "discovery-hint-arrow"
    );
  const arrowPathEl =
    arrowEl.querySelector("path");
  const arrowPath =
    arrowPathEl.getAttribute("d");

  const labelEl =
    document.getElementById(
      "discovery-hint-label"
    );

  const nameEl =
    document.getElementById(
      "discovery-hint-name"
    );

  const visitedIconEl =
    document.getElementById(
      "discovery-hint-visited"
    );

  const metaEl =
    document.getElementById(
      "discovery-hint-meta"
    );

  const announcerEl =
    document.getElementById(
      "discovery-announcer"
    );

  const toggleEl =
    document.getElementById(
      "discovery-toggle"
    );

  const pois = new Map();
  const loadedCells = new Set();
  const failedUntil = new Map();
  const visited = new Set();

  let loading = false;

  let enabled = true;

  try {
    enabled =
      localStorage.getItem(
        ENABLED_KEY
      ) !== "0";
  } catch {
    // ohne localStorage bleibt
    // der Standard (an)
  }

  let target = null;
  let targetSelectionStarted = false;

  // true, sobald alle Orte im Umkreis besucht sind und der Hinweis
  // ausgeblendet wurde. Kommen durch Bewegung neue unbesuchte Orte in
  // Reichweite, wird automatisch wieder ein Ziel eingeblendet.
  let allVisitedHidden = false;

  // Während eines Ortssprungs (Suche, R, Favorit) ausgeblendet,
  // bis der neue Ort geladen ist.
  let suspended = false;

  let lastCellCheck = 0;
  let lastEvaluate = 0;
  let lastArrow = 0;
  let lastLoggedTargetIds = null;
  let showingPin = false;

  let lastPose = null;

  function setEnabled(value) {
    enabled = value;

    toggleEl.checked = value;

    try {
      localStorage.setItem(
        ENABLED_KEY,
        value ? "1" : "0"
      );
    } catch {
      // egal
    }

    if (!value) {
      clearTarget();
    } else {
      // Frischer Start: wieder automatisch das nächstbeste Ziel
      // wählen, statt auf manuelles Durchblättern (X/Y) zu warten.
      targetSelectionStarted = false;
      allVisitedHidden = false;
      lastEvaluate = 0;
    }
  }

  function setSuspended(value) {
    suspended = value;

    if (value) {
      clearTarget();
      targetSelectionStarted = false;
      allVisitedHidden = false;
    } else {
      // Neuer Ort: sofort frisch auswerten und
      // wieder automatisch das nächstbeste Ziel wählen.
      targetSelectionStarted = false;
      lastCellCheck = 0;
      lastEvaluate = 0;
    }
  }

  toggleEl.addEventListener(
    "change",
    () =>
      setEnabled(
        toggleEl.checked
      )
  );

  toggleEl.checked = enabled;

  function clearTarget() {
    target = null;

    hintEl.classList.remove(
      "visible"
    );
  }

  async function loadCell(cell) {
    const cached =
      readCellCache(cell.key);

    if (
      cached &&
      cached.length > 0
    ) {
      for (const poi of cached) {
        pois.set(
          poi.id,
          poi
        );
      }

      loadedCells.add(
        cell.key
      );

      return;
    }

    loading = true;

    try {
      const fresh =
        await fetchCellFromWikidata(
          cell.lat,
          cell.lon
        );

      for (const poi of fresh) {
        pois.set(
          poi.id,
          poi
        );
      }

      loadedCells.add(
        cell.key
      );

      // Leere Ergebnisse nicht cachen -
      // sonst bleibt eine Zelle 7 Tage "leer",
      // obwohl sie nur wegen eines
      // Abfrageproblems nichts geliefert hat.
      if (fresh.length > 0) {
        writeCellCache(
          cell.key,
          fresh
        );
      }

      lastEvaluate = 0;
    } catch (err) {
      console.warn(
        `[Discovery] Zelle ${cell.key} konnte nicht geladen werden ` +
        `(${err?.name ?? "Fehler"}):`,
        err
      );

      if (err?.name === "RateLimitError") {
        rateLimitedUntil =
          performance.now() + err.pauseMs;

        console.warn(
          `[Discovery] Rate-Limit - pausiere ${Math.round(err.pauseMs / 1000)} s`
        );
      } else {
        failedUntil.set(
          cell.key,
          performance.now() +
            RETRY_AFTER_FAILURE_MS
        );
      }
    } finally {
      loading = false;
    }
  }

  function ensureCells(
    now,
    lat,
    lon,
    headingDeg
  ) {
    if (loading) {
      return;
    }

    if (
      now < rateLimitedUntil ||
      performance.now() - lastRequestEndedAt < MIN_REQUEST_GAP_MS
    ) {
      return;
    }

    const headingRad =
      (headingDeg * Math.PI) /
      180;

    const aheadLat =
      lat +
      (Math.cos(headingRad) *
        AHEAD_PREFETCH_M) /
        METERS_PER_DEG_LAT;

    const aheadLon =
      lon +
      (Math.sin(headingRad) *
        AHEAD_PREFETCH_M) /
        (
          METERS_PER_DEG_LON_EQUATOR *
          Math.max(
            0.1,
            Math.cos(
              (lat * Math.PI) /
                180
            )
          )
        );

    for (
      const cell of [
        cellOf(lat, lon),
        cellOf(
          aheadLat,
          aheadLon
        ),
      ]
    ) {
      if (
        loadedCells.has(
          cell.key
        )
      ) {
        continue;
      }

      if (
        (
          failedUntil.get(
            cell.key
          ) ?? 0
        ) > now
      ) {
        continue;
      }

      loadCell(cell);

      // Pro Durchlauf nur eine Zelle.
      return;
    }
  }

  function scoreOf(
    poi,
    distance
  ) {
    return (
      poi.sl /
      (1 + distance / 1000)
    );
  }

  // Alle Kandidaten in Reichweite: nächster unbesuchter Ort zuerst, dann die
  // weiter entfernten, zuletzt die besuchten.
  // Erreichte Orte werden als besucht markiert.
  function collectCandidates(
    lat,
    lon,
    radius
  ) {
    const list = [];
    let urbanNearby = 0;

    for (const poi of pois.values()) {
      const {
        east,
        north,
      } = offsetMeters(
        lat,
        lon,
        poi.lat,
        poi.lon
      );

      const distance =
        Math.hypot(
          east,
          north
        );

      if (
        distance <
        ARRIVED_RADIUS_M
      ) {
        visited.add(
          poi.id
        );
      }

      // Stadt-Erkennung: zählt alle Nicht-Natur-Ziele (auch besuchte) im
      // Nahbereich, damit der Stadt-Modus beim Abarbeiten nicht kippt.
      if (
        distance <= CITY_RADIUS_M &&
        !NATURE_CATEGORY_IDS.has(
          CATEGORIES[poi.cat].id
        )
      ) {
        urbanNearby++;
      }

      if (
        distance > radius
      ) {
        continue;
      }

      list.push({
        poi,
        distance,
        sortDistance: distance,
        visited: visited.has(poi.id),
        score: scoreOf(
          poi,
          distance
        ),
      });
    }

    // In der Stadt: Berge für die Reihenfolge weiter weg rechnen.
    if (urbanNearby >= CITY_MIN_POIS) {
      for (const entry of list) {
        if (
          DEPRIORITIZED_IN_CITY_IDS.has(
            CATEGORIES[entry.poi.cat].id
          )
        ) {
          entry.sortDistance =
            entry.distance *
            MOUNTAIN_CITY_PENALTY;
        }
      }
    }

    // Noch nicht besuchte zuerst, darin nach (ggf. gewichteter) Entfernung
    // aufsteigend; bei Gleichstand entscheidet die Bekanntheit.
    // Besuchte Orte folgen danach, ebenfalls nach Entfernung.
    list.sort(
      (a, b) =>
        Number(a.visited) -
          Number(b.visited) ||
        a.sortDistance -
          b.sortDistance ||
        b.poi.sl -
          a.poi.sl
    );

    return list;
  }

  function evaluate(
    lat,
    lon
  ) {
    const candidates =
      collectCandidates(
        lat,
        lon,
        NEARBY_RADIUS_M *
          KEEP_RADIUS_FACTOR
      );

    const available =
      candidates.filter(
        (candidate) =>
          candidate.distance <=
          NEARBY_RADIUS_M
      );
    const targetIds = available
      .map(
        (candidate) =>
          `${candidate.poi.id}:${candidate.visited ? 1 : 0}`
      )
      .sort();
    const targetSignature = targetIds.join(",");

    labelEl.textContent =
      available.length > 0
        ? `In der Nähe (${available.length})`
        : "In der Nähe";

    if (targetSignature !== lastLoggedTargetIds) {
      lastLoggedTargetIds = targetSignature;
      console.info(
        `[Discovery] Verfügbare Ziele im Umkreis von 10 km (${available.length})`
      );
      console.table(
        available.map((candidate) => ({
          name: candidate.poi.name,
          kategorie: CATEGORIES[candidate.poi.cat].label,
          entfernung_m: Math.round(candidate.distance),
          besucht: candidate.visited,
          id: candidate.poi.id,
        }))
      );
    }

    const current =
      target
        ? candidates.find(
            (c) =>
              c.poi.id ===
              target.poi.id
          ) ?? null
        : null;

    if (target) {
      if (!current) {
        clearTarget();
      } else {
        target = {
          ...target,
          score: current.score,
        };
      }

      return;
    }

    if (
      targetSelectionStarted &&
      !allVisitedHidden
    ) {
      return;
    }

    const best =
      candidates.find(
        (c) =>
          c.distance <=
            NEARBY_RADIUS_M &&
          !c.visited
      ) ?? null;

    if (!best) {
      clearTarget();
      return;
    }

    target = {
      poi: best.poi,
      score: best.score,
      wasVisited: best.visited,
    };
    targetSelectionStarted = true;
    allVisitedHidden = false;

    announceTarget(
      best.poi,
      best.distance
    );
  }

  function announceTarget(
    poi,
    distance
  ) {
    nameEl.textContent =
      poi.name;

    hintEl.classList.add(
      "visible"
    );

    // Nur beim Zielwechsel an Screenreader
    // melden, nicht bei jeder Entfernung.
    announcerEl.textContent =
      `Sehenswürdigkeit in der Nähe: ` +
      `${poi.name}, ` +
      `${CATEGORIES[poi.cat].label}, ` +
      `${formatDistance(distance)}`;

    lastArrow = 0;
  }

  // Nach der Ankunft am Ziel automatisch zur nächsten noch nicht besuchten
  // Sehenswürdigkeit wechseln (wie X). Liefert false, wenn keine übrig ist.
  function advanceToNextUnvisited() {
    if (!lastPose) {
      return false;
    }

    const next =
      collectCandidates(
        lastPose.lat,
        lastPose.lon,
        NEARBY_RADIUS_M
      ).find(
        (c) =>
          !c.visited
      ) ?? null;

    if (!next) {
      return false;
    }

    target = {
      poi: next.poi,
      score: next.score,
      wasVisited: false,
    };
    targetSelectionStarted = true;

    announceTarget(
      next.poi,
      next.distance
    );

    return true;
  }

  function updateArrow(now) {
    if (
      !target ||
      !lastPose
    ) {
      return;
    }

    const {
      east,
      north,
    } = offsetMeters(
      lastPose.lat,
      lastPose.lon,
      target.poi.lat,
      target.poi.lon
    );

    const distance =
      Math.hypot(
        east,
        north
      );

    const arrived =
      distance <= ARRIVED_RADIUS_M;

    // Erstmalige Ankunft an einem bisher unbesuchten Ziel: Timer starten.
    // (Gezielt aufgerufene, schon besuchte Orte wechseln nicht automatisch.)
    if (
      arrived &&
      !target.wasVisited &&
      target.arrivedAt === undefined
    ) {
      target.arrivedAt = now;
    }

    if (
      target.arrivedAt !== undefined &&
      now - target.arrivedAt >=
        AUTO_ADVANCE_MS
    ) {
      if (advanceToNextUnvisited()) {
        return;
      }

      // Nichts mehr übrig: Hinweis ausblenden. evaluate() blendet wieder ein,
      // sobald durch Bewegung neue unbesuchte Orte in Reichweite kommen.
      clearTarget();
      allVisitedHidden = true;
      return;
    }

    // Besucht = Pin ist sichtbar, Pfeil ist weg.
    if (arrived) {
      visited.add(target.poi.id);
    }

    // SVG-Elemente haben keine .hidden-Property,
    // daher das Attribut direkt umschalten.
    visitedIconEl.toggleAttribute(
      "hidden",
      !visited.has(target.poi.id)
    );

    metaEl.textContent =
      `${CATEGORIES[target.poi.cat].label}` +
      (arrived
        ? ""
        : ` · ${formatDistance(distance)}`);

    if (arrived) {
      if (!showingPin) {
        arrowPathEl.setAttribute(
          "d",
          ARRIVED_PIN_PATH
        );
        arrowEl.setAttribute(
          "fill-rule",
          "evenodd"
        );
        arrowEl.style.transform = "none";
        arrowEl.classList.add("arrived");
        showingPin = true;
      }

      return;
    }

    if (showingPin) {
      arrowPathEl.setAttribute(
        "d",
        arrowPath
      );
      arrowEl.removeAttribute(
        "fill-rule"
      );
      arrowEl.classList.remove("arrived");
      showingPin = false;
    }

    const bearingDeg =
      (
        Math.atan2(
          east,
          north
        ) *
        180
      ) /
      Math.PI;

    const relDeg =
      normalizeDegrees(
        bearingDeg -
          lastPose.headingDeg
      );

    arrowEl.style.transform =
      `rotate(${relDeg.toFixed(1)}deg)`;
  }

  // Pro Frame aus dem Tick-Handler rufen.
  // headingRad = Flugrichtung
  // (Norden = 0, im Uhrzeigersinn),
  // wie Cesium-Camera.heading.
  function update(
    now,
    latDeg,
    lonDeg,
    headingRad
  ) {
    if (!enabled || suspended) {
      return;
    }

    const headingDeg =
      (headingRad * 180) /
      Math.PI;

    lastPose = {
      lat: latDeg,
      lon: lonDeg,
      headingDeg,
    };

    if (
      now -
        lastCellCheck >=
      CELL_CHECK_INTERVAL_MS
    ) {
      lastCellCheck = now;

      ensureCells(
        now,
        latDeg,
        lonDeg,
        headingDeg
      );
    }

    if (
      now -
        lastEvaluate >=
      EVALUATE_INTERVAL_MS
    ) {
      lastEvaluate = now;

      evaluate(
        latDeg,
        lonDeg
      );
    }

    if (
      now -
        lastArrow >=
      ARROW_INTERVAL_MS
    ) {
      lastArrow = now;

      updateArrow(now);
    }
  }

  // Durch die Sehenswürdigkeiten
  // in der Nähe blättern.
  //
  // X = nächster
  // Y = vorheriger Ort
  function cycleTarget(
    direction
  ) {
    if (
      !enabled ||
      suspended ||
      !lastPose
    ) {
      return;
    }

    // Vorwärts (X): nur noch nicht besuchte Orte. Rückwärts (Z): alle, auch
    // besuchte (diese stehen in der Liste hinter den unbesuchten).
    const candidates =
      collectCandidates(
        lastPose.lat,
        lastPose.lon,
        NEARBY_RADIUS_M
      ).filter(
        (c) =>
          direction < 0 ||
          !c.visited
      );

    if (
      candidates.length === 0
    ) {
      return;
    }

    const currentIndex =
      target
        ? candidates.findIndex(
            (c) =>
              c.poi.id ===
              target.poi.id
          )
        : -1;

    let index;

    if (
      currentIndex < 0
    ) {
      index =
        direction > 0
          ? 0
          : candidates.length - 1;
    } else {
      index =
        (
          currentIndex +
          direction +
          candidates.length
        ) %
        candidates.length;
    }

    const next =
      candidates[index];

    target = {
      poi: next.poi,
      score: next.score,
      wasVisited: next.visited,
    };
    targetSelectionStarted = true;
    allVisitedHidden = false;

    announceTarget(
      next.poi,
      next.distance
    );
  }

  return {
    update,
    cycleTarget,
    setEnabled,
    setSuspended,
  };
}
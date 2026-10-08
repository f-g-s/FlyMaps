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

const CACHE_PREFIX = "flymaps_poi_cell_v2_";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ENABLED_KEY = "flymaps_discovery_enabled";

const NEARBY_RADIUS_M = 10000;
const ARRIVED_RADIUS_M = 300;
const ARRIVED_PIN_PATH = "M12 2a8 8 0 0 0-8 8c0 5 8 12 8 12s8-7 8-12a8 8 0 0 0-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z";
const KEEP_RADIUS_FACTOR = 1.3;
const EVALUATE_INTERVAL_MS = 1000;
const ARROW_INTERVAL_MS = 100;
const CELL_CHECK_INTERVAL_MS = 1500;

// Kategorien. Reihenfolge = Priorität, falls ein Ort zu mehreren passt
// (spezifischer zuerst). minSitelinks filtert nach Bekanntheit; die
// Größenangaben greifen nur, wenn Wikidata einen Wert kennt - Orte ohne
// Maßangabe bleiben bei ausreichender Bekanntheit erhalten.
// Höhe/Länge in Metern, Fläche in m².
const CATEGORIES = [
  { id: "cathedral", label: "Kathedrale", classes: ["Q2977"], minSitelinks: 6 },
  { id: "church", label: "Kirche", classes: ["Q16970"], minSitelinks: 14 },
  { id: "mosque", label: "Moschee", classes: ["Q32815"], minSitelinks: 6 },
  { id: "synagogue", label: "Synagoge", classes: ["Q34627"], minSitelinks: 6 },
  { id: "castle", label: "Burg", classes: ["Q23413"], minSitelinks: 8 },
  { id: "palace", label: "Schloss", classes: ["Q16560"], minSitelinks: 8 },
  { id: "fortification", label: "Festung", classes: ["Q57821"], minSitelinks: 6 },
  { id: "bridge", label: "Brücke", classes: ["Q12280"], minSitelinks: 8, minLength: 200 },
  { id: "dam", label: "Staumauer", classes: ["Q12323"], minSitelinks: 5 },
  { id: "skyscraper", label: "Hochhaus", classes: ["Q11303"], minSitelinks: 5, minHeight: 100 },
  { id: "tower", label: "Turm", classes: ["Q12518"], minSitelinks: 8, minHeight: 50 },
  { id: "lighthouse", label: "Leuchtturm", classes: ["Q39715"], minSitelinks: 6 },
  { id: "stadium", label: "Stadion", classes: ["Q483110"], minSitelinks: 6 },
  { id: "opera", label: "Opernhaus", classes: ["Q153562"], minSitelinks: 5 },
  { id: "square", label: "Platz", classes: ["Q174782"], minSitelinks: 8 },
  { id: "park", label: "Park", classes: ["Q22698"], minSitelinks: 8, minArea: 100000 },
  { id: "monument", label: "Denkmal", classes: ["Q4989906"], minSitelinks: 12 },
  { id: "power", label: "Kraftwerk", classes: ["Q159719"], minSitelinks: 5 },
  { id: "factory", label: "Industrieanlage", classes: ["Q83405"], minSitelinks: 6 },
  { id: "mine", label: "Bergwerk", classes: ["Q820477"], minSitelinks: 6 },
  { id: "port", label: "Hafen", classes: ["Q44782"], minSitelinks: 6 },
  { id: "airport", label: "Flughafen", classes: ["Q1248784"], minSitelinks: 8 },
  { id: "station", label: "Bahnhof", classes: ["Q55488"], minSitelinks: 10 },
  { id: "amusement", label: "Freizeitpark", classes: ["Q194195"], minSitelinks: 4 },
  { id: "zoo", label: "Zoo", classes: ["Q43501"], minSitelinks: 6 },
];

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
// Keine globale P279*-Klassenhierarchie mehr in jeder Anfrage.
// Es werden nur direkte P31-Klassen der Kategorien abgefragt.
// Das vermeidet die extrem teure Unterklassenauflösung in Wikidata.
function buildQuery(lat, lon, radiusKm, minSitelinks) {
  const values = [...CATEGORY_INDEX_BY_CLASS.keys()]
    .map((q) => `wd:${q}`)
    .join(" ");

  return `
SELECT ?item ?coord ?sitelinks ?cat ?de ?en ?area ?height ?length WHERE {

  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .

    bd:serviceParam
      wikibase:center
      "Point(${lon} ${lat})"^^geo:wktLiteral .

    bd:serviceParam
      wikibase:radius
      "${radiusKm}" .
  }

  ?item wdt:P31 ?cat .

  VALUES ?cat {
    ${values}
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
    }
  }

  const result = [];

  for (const poi of byId.values()) {
    if (!poi.name || /^Q\d+$/.test(poi.name)) {
      continue;
    }

    const category = CATEGORIES[poi.cat];

    if (poi.sl < category.minSitelinks) {
      continue;
    }

    if (
      category.minHeight &&
      poi.height !== null &&
      poi.height < category.minHeight
    ) {
      continue;
    }

    if (
      category.minLength &&
      poi.length !== null &&
      poi.length < category.minLength
    ) {
      continue;
    }

    if (
      category.minArea &&
      poi.area !== null &&
      poi.area < category.minArea
    ) {
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

  const nameEl =
    document.getElementById(
      "discovery-hint-name"
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

      failedUntil.set(
        cell.key,
        performance.now() +
          RETRY_AFTER_FAILURE_MS
      );
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

  // Alle Kandidaten in Reichweite,
  // bekannteste/nächste zuerst.
  // Erreichte Orte werden als besucht markiert.
  function collectCandidates(
    lat,
    lon,
    radius
  ) {
    const list = [];

    for (const poi of pois.values()) {
      const isCurrentTarget =
        target?.poi.id === poi.id;

      if (
        visited.has(poi.id) &&
        !isCurrentTarget
      ) {
        continue;
      }

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

        if (!isCurrentTarget) {
          continue;
        }
      }

      if (
        distance > radius
      ) {
        continue;
      }

      list.push({
        poi,
        distance,
        score: scoreOf(
          poi,
          distance
        ),
      });
    }

    list.sort(
      (a, b) =>
        b.score -
        a.score
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
      .map((candidate) => candidate.poi.id)
      .sort();
    const targetSignature = targetIds.join(",");

    if (
      import.meta.env.DEV &&
      targetSignature !== lastLoggedTargetIds
    ) {
      lastLoggedTargetIds = targetSignature;
      console.info(
        `[Discovery] Verfügbare Ziele im Umkreis von 10 km (${available.length})`
      );
      console.table(
        available.map((candidate) => ({
          name: candidate.poi.name,
          kategorie: CATEGORIES[candidate.poi.cat].label,
          entfernung_m: Math.round(candidate.distance),
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

    if (targetSelectionStarted) {
      return;
    }

    const best =
      candidates.find(
        (c) =>
          c.distance <=
          NEARBY_RADIUS_M
      ) ?? null;

    if (!best) {
      clearTarget();
      return;
    }

    target = {
      poi: best.poi,
      score: best.score,
    };
    targetSelectionStarted = true;

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

    const arrived = distance <= 100;

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
    if (!enabled) {
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
      !lastPose
    ) {
      return;
    }

    const candidates =
      collectCandidates(
        lastPose.lat,
        lastPose.lon,
        NEARBY_RADIUS_M
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
    };
    targetSelectionStarted = true;

    announceTarget(
      next.poi,
      next.distance
    );
  }

  return {
    update,
    cycleTarget,
    setEnabled,
  };
}
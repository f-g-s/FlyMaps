#!/usr/bin/env node
// Einmaliges Hilfsskript: reichert die 3D-Spots-Liste mit Koordinaten an.
//
// Liest src/google_earth_3d_locations_by_country.json, ermittelt für jeden
// Eintrag Koordinaten und schreibt sie nach src/spot_coordinates.json
// ({ "Land|Spot-Name": [lat, lng] }). FlyMaps nutzt diese Koordinaten, um Spots
// direkt anzufliegen - auch bei ausgeschaltetem Geocoding und ohne API-Aufruf
// pro Klick.
//
// Zwei Anbieter (Node 18+):
//
//   --provider=openmeteo   kostenlos, ohne Key (Open-Meteo Geocoding, Datenbasis
//                          GeoNames; nur für nicht-kommerzielle Nutzung).
//                          node scripts/build-spot-coordinates.mjs --provider=openmeteo
//
//   --provider=google      (Standard) Google Geocoding API, braucht Key und
//                          verbraucht das monatliche Freikontingent:
//                          GOOGLE_MAPS_API_KEY=dein-key node scripts/build-spot-coordinates.mjs
//
// Fortsetzbar: vorhandene Einträge in spot_coordinates.json werden übersprungen,
// Strg+C speichert den Zwischenstand. Nicht gefundene Einträge stehen in
// scripts/spot-coordinates-failed.txt und werden beim nächsten Lauf erneut
// versucht - auch mit dem anderen Anbieter (z.B. Lücken im nächsten Monat per
// Google füllen). Bei openmeteo werden ungenaue Treffer (nur ein Teil des
// Spot-Namens gefunden bzw. nur unscharfer Namenstreffer) in
// scripts/spot-coordinates-approx.txt gelistet.
//
// Option --redo-dupes: löst alle Einträge neu auf, die dieselben Koordinaten wie
// ein anderer Eintrag haben (typisches Zeichen für unscharfe Fehltreffer, z.B.
// "Redding" -> "Reading"). Schlägt die neue Suche fehl, bleibt der alte Wert.
import { readFile, writeFile, rm } from "node:fs/promises";

const providerArg = process.argv.find((a) => a.startsWith("--provider="));
const PROVIDER = providerArg ? providerArg.split("=")[1] : "google";
if (!["google", "openmeteo"].includes(PROVIDER)) {
  console.error('Unbekannter Anbieter. Erlaubt: --provider=google | --provider=openmeteo');
  process.exit(1);
}

const REDO_DUPES = process.argv.includes("--redo-dupes");
const KEY = process.env.GOOGLE_MAPS_API_KEY;
if (PROVIDER === "google" && !KEY) {
  console.error("GOOGLE_MAPS_API_KEY fehlt (siehe Kommentar am Dateianfang).");
  process.exit(1);
}

// Nur für Tests überschreibbar (lokaler Mock-Server).
const ENDPOINT =
  process.env.GEOCODE_ENDPOINT ??
  (PROVIDER === "google"
    ? "https://maps.googleapis.com/maps/api/geocode/json"
    : "https://geocoding-api.open-meteo.com/v1/search");
const CONCURRENCY = 4; // parallele Anfragen
// Mindestabstand zwischen zwei Anfragen (global). Open-Meteo bekommt mehr Luft,
// weil pro Spot mehrere Anfragen nötig sein können.
const MIN_INTERVAL_MS = Number(
  process.env.MIN_INTERVAL_MS ?? (PROVIDER === "google" ? 120 : 250),
);

const SPOTS_URL = new URL("../src/google_earth_3d_locations_by_country.json", import.meta.url);
const OUT_URL = new URL("../src/spot_coordinates.json", import.meta.url);
// Zwischenstand liegt bewusst AUSSERHALB von src/: spot_coordinates.json wird von
// main.js importiert, und jede Änderung daran würde im laufenden Vite-Dev-Server
// einen kompletten Seiten-Reload auslösen. Erst am Ende (oder bei Strg+C) wird
// src/spot_coordinates.json einmal geschrieben.
const PARTIAL_URL = new URL("./spot-coordinates.partial.json", import.meta.url);
const FAILED_URL = new URL("./spot-coordinates-failed.txt", import.meta.url);
const APPROX_URL = new URL("./spot-coordinates-approx.txt", import.meta.url);

// ISO-3166-1-Alpha-2-Codes der Länder in der Spot-Liste (Open-Meteo liefert
// pro Treffer einen country_code, danach wird gefiltert; Kosovo = XK).
const ISO = {
  "The Bahamas": "BS", Canada: "CA", Mexico: "MX", "United States": "US",
  Argentina: "AR", Brazil: "BR", Chile: "CL", Albania: "AL", Austria: "AT",
  Belgium: "BE", "Bosnia and Herzegovina": "BA", Bulgaria: "BG", Croatia: "HR",
  Czechia: "CZ", Denmark: "DK", Finland: "FI", France: "FR", Germany: "DE",
  Greece: "GR", Hungary: "HU", Iceland: "IS", Ireland: "IE", Italy: "IT",
  Kosovo: "XK", Latvia: "LV", Lithuania: "LT", Luxembourg: "LU", Malta: "MT",
  Monaco: "MC", Montenegro: "ME", Netherlands: "NL", Norway: "NO", Poland: "PL",
  Portugal: "PT", Romania: "RO", "San Marino": "SM", Serbia: "RS",
  Slovakia: "SK", Slovenia: "SI", Spain: "ES", Sweden: "SE", Switzerland: "CH",
  "United Kingdom": "GB", "Vatican City": "VA", Macau: "MO", "Hong Kong": "HK",
  Japan: "JP", Philippines: "PH", Singapore: "SG", Malaysia: "MY", Taiwan: "TW",
  "South Africa": "ZA", Morocco: "MA", Tunisia: "TN", Australia: "AU",
  "New Zealand": "NZ",
};

const spotsByCountry = JSON.parse(await readFile(SPOTS_URL, "utf8"));
let result = {};
for (const url of [OUT_URL, PARTIAL_URL]) {
  try {
    Object.assign(result, JSON.parse(await readFile(url, "utf8")));
  } catch {
    // Datei fehlt noch - egal
  }
}

// Gleiche Schlüssel-Regel wie main.js (getSpotCoords).
const keyOf = (country, name) => `${country}|${name}`;
const isEntireCountry = (name) => /^entire country/i.test(name);

// Alter Wert als Rückfall, falls die Neuauflösung scheitert (--redo-dupes).
const previous = {};
if (REDO_DUPES) {
  const byCoords = new Map();
  for (const [k, v] of Object.entries(result)) {
    const id = v.join(",");
    byCoords.set(id, [...(byCoords.get(id) ?? []), k]);
  }
  let n = 0;
  for (const keys of byCoords.values()) {
    if (keys.length < 2) continue;
    for (const k of keys) {
      previous[k] = result[k];
      delete result[k];
      n++;
    }
  }
  console.log(`--redo-dupes: ${n} Einträge mit identischen Koordinaten werden neu aufgelöst.`);
}

const todo = [];
for (const [country, names] of Object.entries(spotsByCountry)) {
  for (const name of names) {
    if (!result[keyOf(country, name)]) todo.push({ country, name });
  }
}
console.log(
  `Anbieter: ${PROVIDER}. ${todo.length} Spots abzufragen (${Object.keys(result).length} schon vorhanden).`,
);

const failed = [];
const approx = [];
let done = 0;
let lastRequestAt = 0;

// final=false: nur Zwischenstand (scripts/), final=true: src/spot_coordinates.json.
async function save(final = false) {
  const sorted = Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b, "en")),
  );
  const json = JSON.stringify(sorted, null, 1) + "\n";
  if (final) {
    await writeFile(OUT_URL, json);
    await rm(PARTIAL_URL, { force: true });
  } else {
    await writeFile(PARTIAL_URL, json);
  }
  await writeFile(FAILED_URL, failed.join("\n") + (failed.length ? "\n" : ""));
  if (PROVIDER === "openmeteo") {
    await writeFile(APPROX_URL, approx.join("\n") + (approx.length ? "\n" : ""));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Einfaches globales Rate-Limiting + Retry bei Limit-/Serverfehlern.
async function getJson(url) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    lastRequestAt = Math.max(Date.now(), lastRequestAt + MIN_INTERVAL_MS);
    if (wait > 0) await sleep(wait);
    try {
      const response = await fetch(url);
      if (response.status === 429 || response.status >= 500) {
        await sleep(2000 * attempt);
        continue;
      }
      return await response.json();
    } catch (err) {
      if (attempt === 6) throw err;
      await sleep(Math.min(30000, 2000 * 2 ** (attempt - 1))); // 2s, 4s, 8s, ...
    }
  }
  return { status: "OVER_QUERY_LIMIT" };
}

// --- Google ---------------------------------------------------------------
// "Entire country ..."-Einträge sind kein Ortsname -> Ländername abfragen
// (wie im Spot-Klick-Handler in main.js). Sonst Name + Land: das vermeidet
// Verwechslungen gleichnamiger Orte in anderen Ländern.
async function resolveGoogle(country, name) {
  const query = isEntireCountry(name) ? country : `${name}, ${country}`;
  const params = new URLSearchParams({ address: query, language: "de", key: KEY });
  const data = await getJson(`${ENDPOINT}?${params}`);
  if (data.status === "REQUEST_DENIED") {
    throw Object.assign(new Error(data.error_message ?? "REQUEST_DENIED"), { fatal: true });
  }
  if (data.status === "OK" && data.results?.length) {
    const { lat, lng } = data.results[0].geometry.location;
    return { coords: [lat, lng] };
  }
  return { status: data.status ?? "UNKNOWN_ERROR" };
}

// --- Open-Meteo -----------------------------------------------------------
// Open-Meteo sucht nach EINEM Ortsnamen. Viele Spot-Einträge sind aber mehrere
// aneinandergereihte Städte ("Weinheim Ravensburg Reutlingen Stuttgart") oder
// haben Zusätze ("Area North of ...", "(East)"). Deshalb werden der Reihe nach
// Kandidaten probiert: erst der ganze (bereinigte) Name, dann Wort-Präfixe
// mit 4/3/2/1 Wörtern - der erste Treffer im richtigen Land gewinnt. Das ist
// bei Mehrfach-Einträgen bewusst nur eine Näherung (erste Stadt der Gruppe).
function openMeteoCandidates(country, rawName) {
  if (isEntireCountry(rawName)) return [country];
  let name = rawName
    .replace(/^Areas?\s+(?:north|south|east|west|northeast|northwest|southeast|southwest)(?:\s+and\s+\w+)?\s+of\s+/i, "")
    .replace(/\([^)]*\)?/g, " ") // "(East)", unvollständige Klammern
    .replace(/[|]/g, " ");
  // Teile an Kommas getrennt behandeln ("Hotel Zone, Cancún", "Grand Island, Nebraska")
  const parts = name.split(",").map((p) => p.trim()).filter(Boolean);
  const ordered = parts.length > 1 ? [parts[0], ...parts.slice(1).reverse()] : parts;
  const out = [];
  for (const part of ordered) {
    const words = part.split(/\s+/).filter(Boolean);
    const lengths = [...new Set([words.length, 4, 3, 2, 1])]
      .filter((n) => n >= 1 && n <= words.length)
      .sort((a, b) => b - a);
    for (const n of lengths) {
      const candidate = words.slice(0, n).join(" ");
      if (candidate.length >= 3 && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out.slice(0, 7); // Obergrenze pro Spot
}

// Open-Meteo sucht unscharf: "Redding" liefert u.U. zuerst das größere "Reading".
// Deshalb unter den Treffern zuerst einen mit exakt gleichem Namen nehmen
// (ohne Groß-/Kleinschreibung, Akzente, Satzzeichen); sonst der erste Treffer.
const norm = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function pickOpenMeteoHit(results, candidate) {
  const wanted = norm(candidate);
  const exactHit = results.find((r) => norm(r.name) === wanted);
  if (exactHit) return { hit: exactHit, exact: true };
  return { hit: results[0] ?? null, exact: false };
}

async function resolveOpenMeteo(country, name) {
  const iso = ISO[country];
  if (!iso) return { status: "NO_ISO_CODE" };
  const candidates = openMeteoCandidates(country, name);
  for (const candidate of candidates) {
    const params = new URLSearchParams({
      name: candidate,
      count: "10",
      language: "de",
      format: "json",
    });
    const data = await getJson(`${ENDPOINT}?${params}`);
    // Nach Land filtern statt dem Filter-Parameter zu vertrauen.
    const inCountry = (data.results ?? []).filter((r) => r.country_code === iso);
    const { hit, exact } = pickOpenMeteoHit(inCountry, candidate);
    if (hit) {
      const notes = [];
      if (candidate !== name && !isEntireCountry(name)) notes.push(`Teilname "${candidate}"`);
      if (!exact) notes.push(`unscharf: "${hit.name}"`);
      if (notes.length) approx.push(`${keyOf(country, name)}\t-> ${notes.join(", ")}`);
      return { coords: [hit.latitude, hit.longitude] };
    }
  }
  return { status: "NOT_FOUND" };
}

const resolve = PROVIDER === "google" ? resolveGoogle : resolveOpenMeteo;

let abortRequested = false;
process.on("SIGINT", () => {
  abortRequested = true;
  console.log("\nAbbruch - speichere Zwischenstand…");
});

async function worker() {
  while (todo.length && !abortRequested) {
    const { country, name } = todo.shift();
    const label = keyOf(country, name);
    try {
      const r = await resolve(country, name);
      if (r.coords) {
        result[label] = [Number(r.coords[0].toFixed(5)), Number(r.coords[1].toFixed(5))];
      } else if (previous[label]) {
        result[label] = previous[label]; // Neuauflösung gescheitert -> alten Wert behalten
      } else {
        failed.push(`${label}\t${r.status}`);
      }
    } catch (err) {
      if (err.fatal) {
        // Key/Rechte falsch: sinnlos weiterzumachen.
        console.error(`${err.message} - Key prüfen (Geocoding API aktiviert? Referrer-Beschränkung?)`);
        abortRequested = true;
        return;
      }
      if (previous[label]) result[label] = previous[label];
      else failed.push(`${label}\t${err.message}`);
    }
    if (++done % 50 === 0) {
      console.log(`${done} erledigt…`);
      await save(false);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await save(true);
console.log(
  `Fertig: ${Object.keys(result).length} Koordinaten gespeichert, ${failed.length} fehlgeschlagen` +
    (abortRequested && todo.length ? `, ${todo.length} noch offen (erneut starten).` : "."),
);
if (failed.length) console.log("Fehlgeschlagene Einträge: scripts/spot-coordinates-failed.txt");
if (approx.length) console.log("Ungenaue Treffer (nur Namensteil gefunden): scripts/spot-coordinates-approx.txt");

// Geocoding direkt im Browser mit dem API-Key des Spielers (siehe apikey.js).
// Ersetzt die frühere Cloudflare-Function /api/geocode, die einen serverseitigen
// Key des Betreibers genutzt hat. Liefert dieselbe Antwortform wie diese:
//   geocode({ q })       - Adresse/Ort -> { status, lat, lng, formatted_address }
//   geocode({ latlng })  - Koordinaten -> zusätzlich { place, district, country }
// Fehler kommen als { status, error } zurück (z.B. "NO_KEY", "REQUEST_DENIED");
// nur echte Netzwerkfehler werfen.
import { getApiKey, hasStoredApiKey } from "./apikey.js";

const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

// Zentrale Sperre: Ist das Geocoding pausiert (Schalter im Einstellungsmenü),
// geht von hier aus keine Anfrage mehr raus - egal welche Funktion geocode()
// aufruft (Bauchbinde, Ortssuche, Spots, Aktueller Ort, Zufallsstart).
let geocodingPaused = false;

export function setGeocodingPaused(paused) {
  geocodingPaused = Boolean(paused);
}

export function isGeocodingPaused() {
  return geocodingPaused;
}

export async function geocode({ q, latlng }, keyOverride) {
  if (geocodingPaused) {
    return { status: "PAUSED", error: "Geocoding ist pausiert." };
  }

  // Nur lokale Entwicklung (vite dev) ohne im Dialog eingegebenen Key: wie
  // bisher über die lokale /api/geocode-Function (functions/api/geocode.js)
  // mit dem eigenen Geocoding-Key. Im Produktions-Build gibt es diesen Weg nicht.
  if (import.meta.env.DEV && !keyOverride && !hasStoredApiKey()) {
    // URL genau wie früher aufgebaut (Komma in latlng unkodiert).
    const devUrl = latlng
      ? `/api/geocode?latlng=${latlng}`
      : `/api/geocode?q=${encodeURIComponent(q ?? "")}`;
    const devResponse = await fetch(devUrl);
    return devResponse.json();
  }

  const key = keyOverride ?? getApiKey();
  if (!key) return { status: "NO_KEY", error: "Kein API-Key hinterlegt." };
  if (!q?.trim() && !latlng?.trim()) {
    return { status: "INVALID_REQUEST", error: 'Parameter "q" oder "latlng" fehlt.' };
  }

  const params = new URLSearchParams({ language: "de", key });
  if (latlng) params.set("latlng", latlng);
  else params.set("address", q);

  const response = await fetch(`${GEOCODE_ENDPOINT}?${params}`);
  const data = await response.json();

  if (data.status !== "OK" || !data.results?.length) {
    return { status: data.status ?? "UNKNOWN_ERROR", error: data.error_message };
  }

  const { lat, lng } = data.results[0].geometry.location;
  const result = {
    status: "OK",
    lat,
    lng,
    formatted_address: data.results[0].formatted_address,
  };

  // Nur beim Reverse-Geocoding Land + Ort/Viertel aufbereiten (Standort-Banner).
  if (latlng) {
    const place = pickPlaceName(data.results);
    result.place = place;
    result.district = pickDistrictName(data.results, place);
    result.country = pickCountryName(data.results);
  }
  return result;
}

// Google liefert beim Reverse-Geocoding mehrere Ergebnisse mit
// unterschiedlicher Granularität (Hausnummer, Straße, Ortsteil/Contrada,
// Gemeinde, Provinz/Metropolitanstadt, Bundesland, Land, ...), erkennbar am
// "types"-Array jedes Eintrags. Für die Bauchbinde wird bewusst zuerst die
// eigentliche Stadt/Gemeinde ("locality") gesucht statt der kleinstmöglichen
// Einheit - kleinere Einheiten wie "neighborhood"/"sublocality" (z.B.
// italienische "Contrada"-Ortsteile) sind oft winzige, dicht an der
// Gemeindegrenze liegende Polygone und würden sonst kurz vor/nach der
// eigentlichen Stadt kurz aufflackern. Erst wenn keine "locality" vorliegt
// (ländliche Gegend ohne eigenen Ortsnamen), wird auf kleinere bzw. größere
// Einheiten ausgewichen.
const PLACE_TYPE_PRIORITY = [
  //'locality',
  'sublocality',
  'sublocality_level_1',
  'locality',
  'administrative_area_level_3',
  'administrative_area_level_2',
  'administrative_area_level_1',
];

function pickPlaceName(results) {
  for (const type of PLACE_TYPE_PRIORITY) {
    for (const result of results) {
      if (!result.types?.includes(type)) continue;
      const component = result.address_components?.find((c) => c.types?.includes(type));
      if (component?.long_name) return component.long_name;
    }
  }
  return null;
}

// Viertel/Stadtteil (z.B. "Nördliche Innenstadt", "Paulusviertel") - wird
// im Banner zusätzlich unter dem Ortsnamen gezeigt. Reihenfolge = welcher
// Google-Typ bevorzugt wird; welcher Typ in einer Region welche Ebene
// abbildet, unterscheidet sich je nach Land/Stadt (siehe debug=1 oben).
// Ergibt sich kein Viertel oder ist es identisch mit dem Ortsnamen, bleibt
// das Feld null und das Banner zeigt wie bisher nur Ort + Land.
const DISTRICT_TYPE_PRIORITY = [
  'locality',
  'sublocality',
  'sublocality_level_1',
  'neighborhood',
  'sublocality_level_2',
];

function pickDistrictName(results, place) {
  for (const type of DISTRICT_TYPE_PRIORITY) {
    for (const result of results) {
      const component = result.address_components?.find((c) => c.types?.includes(type));
      const name = component?.long_name;
      if (name && name !== place) return name;
    }
  }
  return null;
}

function pickCountryName(results) {
  for (const result of results) {
    const component = result.address_components?.find((c) => c.types?.includes('country'));
    if (component?.long_name) return component.long_name;
  }
  return null;
}
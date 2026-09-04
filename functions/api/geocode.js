// Cloudflare Pages Function - läuft serverseitig, NICHT im Browser-Bundle.
// Routen:
//   /api/geocode?q=<Suchbegriff>        - Adresse/Ort -> Koordinaten (Ortssuche)
//   /api/geocode?latlng=<lat>,<lng>     - Koordinaten -> Adresse (aktueller Ort im Pausenmodus)
// Beide Richtungen laufen über denselben Google-Geocoding-Endpunkt, daher
// hier in einer Function gebündelt statt dupliziert.
//
// Hält den Google-Key für die Geocoding API server-seitig (env.GEOCODING_API_KEY),
// damit er nie im Client-Code auftaucht. Die Geocoding API ist eine
// "Web Service"-API und akzeptiert grundsätzlich keine HTTP-Referrer-
// Restriction (nur IP) - über diesen Proxy ist das kein Problem mehr, weil
// der Key den Client-Browser gar nicht mehr erreicht.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  const latlng = url.searchParams.get('latlng');

  if ((!query || !query.trim()) && (!latlng || !latlng.trim())) {
    return jsonResponse({ status: 'INVALID_REQUEST', error: 'Parameter "q" oder "latlng" fehlt.' }, 400);
  }

  if (!env.GEOCODING_API_KEY) {
    // Fehlkonfiguration (Umgebungsvariable in Cloudflare Pages nicht gesetzt) -
    // klar von einem "kein Ergebnis" unterscheiden, damit man es schnell findet.
    return jsonResponse({ status: 'SERVER_ERROR', error: 'GEOCODING_API_KEY ist auf dem Server nicht konfiguriert.' }, 500);
  }

  const googleUrl = latlng
    ? `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(latlng)}&key=${env.GEOCODING_API_KEY}`
    : `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${env.GEOCODING_API_KEY}`;

  let data;
  try {
    const response = await fetch(googleUrl);
    data = await response.json();
  } catch (err) {
    return jsonResponse({ status: 'SERVER_ERROR', error: 'Geocoding-Anfrage an Google fehlgeschlagen.' }, 502);
  }

  if (data.status !== 'OK' || !data.results?.length) {
    return jsonResponse({ status: data.status ?? 'UNKNOWN_ERROR' }, 200);
  }

  // Nur die Felder zurückgeben, die der Client tatsächlich braucht - nicht
  // die komplette Google-Antwort (u.a. keine internen Google-Details/Keys).
  const { lat, lng } = data.results[0].geometry.location;
  return jsonResponse({
    status: 'OK',
    lat,
    lng,
    formatted_address: data.results[0].formatted_address,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
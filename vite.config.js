import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FAVORITES_FILE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'FlyMaps',
  'favorites.json'
);

function localFavoritesPlugin() {
  return {
    name: 'flymaps-local-favorites',
    configureServer(server) {
      server.middlewares.use('/api/favorites', handleFavoritesRequest);
      server.middlewares.use('/api/geocode', handleGeocodeRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/favorites', handleFavoritesRequest);
      server.middlewares.use('/api/geocode', handleGeocodeRequest);
    },
  };
}

async function handleFavoritesRequest(req, res) {
  try {
    if (req.method === 'GET') {
      const favorites = await readFavorites();
      sendJson(res, 200, { favorites, storagePath: FAVORITES_FILE });
      return;
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const favorites = Array.isArray(body?.favorites) ? body.favorites : null;
      if (!favorites) {
        sendJson(res, 400, { error: 'favorites must be an array' });
        return;
      }

      await writeFavorites(favorites);
      sendJson(res, 200, { favorites, storagePath: FAVORITES_FILE });
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Could not access local favorites file' });
  }
}

async function readFavorites() {
  try {
    const raw = await fs.readFile(FAVORITES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeFavorites(favorites) {
  await fs.mkdir(path.dirname(FAVORITES_FILE), { recursive: true });
  await fs.writeFile(FAVORITES_FILE, `${JSON.stringify(favorites, null, 2)}\n`, 'utf8');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function handleGeocodeRequest(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const query = new URL(req.url, 'http://localhost').searchParams.get('q')?.trim();
  if (!query) {
    sendJson(res, 400, { status: 'INVALID_REQUEST', error: 'Parameter "q" fehlt.' });
    return;
  }

  const apiKey = await readLocalGeocodingKey();
  if (!apiKey) {
    sendJson(res, 500, { status: 'SERVER_ERROR', error: 'GEOCODING_API_KEY fehlt in .dev.vars.' });
    return;
  }

  try {
    const googleUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
    const response = await fetch(googleUrl);
    const data = await response.json();

    if (data.status !== 'OK' || !data.results?.length) {
      sendJson(res, 200, { status: data.status ?? 'UNKNOWN_ERROR' });
      return;
    }

    const result = data.results[0];
    sendJson(res, 200, {
      status: 'OK',
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      formatted_address: result.formatted_address,
    });
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { status: 'SERVER_ERROR', error: 'Geocoding-Anfrage an Google fehlgeschlagen.' });
  }
}

async function readLocalGeocodingKey() {
  try {
    const contents = await fs.readFile('.dev.vars', 'utf8');
    const match = contents.match(/^GEOCODING_API_KEY\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\r\n#]*))/m);
    return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

// vite-plugin-cesium kopiert automatisch Cesiums statische Assets
// (Workers, Widgets-CSS, Assets) und setzt CESIUM_BASE_URL korrekt.
export default defineConfig({
  plugins: [localFavoritesPlugin(), cesium()],
  server: {
    port: 5173,
  },
});

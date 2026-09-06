import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import spotsByCountry from "./google_earth_3d_locations_by_country.json";

// --- API-Key konfigurieren -------------------------------------------------
const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
if (!apiKey) {
  throw new Error("VITE_GOOGLE_MAPS_API_KEY fehlt - siehe .env.example");
}
Cesium.GoogleMaps.defaultApiKey = apiKey;

// Ohne eigenen Cesium-ion-Token brauchen wir Cesiums Standard-Weltterrain/
// Imagery nicht - wir nutzen ausschließlich Googles Photorealistic 3D Tiles.
Cesium.Ion.defaultAccessToken = undefined;

const statusEl = document.getElementById("status");
const speedEl = document.getElementById("speed");
const altitudeEl = document.getElementById("altitude");
const loadingOverlayEl = document.getElementById("loading-overlay");
const cesiumContainerEl = document.getElementById("cesiumContainer");
const minimapContainerEl = document.getElementById("minimap");
const hudEl = document.getElementById("hud");
const randomSpotButton = document.getElementById("random-spot-button");
let isStatusVisible = true;
let isPaused = false;
let baseStatusText = "Lade Weltdaten…";
let minimapWidget;

function setStatus(text) {
  baseStatusText = text;
  if (!isPaused) statusEl.textContent = text;
}

// Blendet #hud komplett aus (statt nur den Status-Text), damit kein leeres
// Bubble-Panel mit Hintergrund/Padding stehen bleibt, wenn nichts drin steht.
function setStatusVisible(visible) {
  isStatusVisible = visible;
  if (isPaused) return; // während Pause immer sichtbar (siehe togglePause)
  hudEl.style.display = visible ? "" : "none";
}

const viewer = new Cesium.Viewer("cesiumContainer", {
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  timeline: false,
  animation: false,
  infoBox: false,
  selectionIndicator: false,
  // Kein eigenes Terrain/Imagery laden - die 3D Tiles bringen bereits
  // eine fotorealistische Mesh-Oberfläche mit.
  baseLayer: false,
  terrain: undefined,
  // Cesiums eigenes "Rendering has stopped"-Overlay unterdrücken - wir
  // fangen fatale Render-/Context-Fehler stattdessen selbst ab (siehe
  // recoverFromFatalRenderError) und laden neu, statt den Nutzer mit
  // einer eingefrorenen Szene und Fehlerdialog sitzen zu lassen.
  showRenderLoopErrors: false,
});

// Nach längeren Sessions (Erfahrungswert: ca. alle 20 Minuten) kann der
// GPU-Treiber/Browser den WebGL-Context verlieren (z.B. durch Speicherdruck
// von den vielen gestreamten 3D-Tiles) - Cesiums Framebuffer-Code wirft dann
// einen fatalen "Expected width to be greater than 0"-Fehler und stoppt
// komplett (bekannter, bislang ungelöster Cesium-Bug, siehe
// https://github.com/CesiumGS/cesium/issues/11533). Statt dessen fangen wir
// echten Context-Verlust sowie Cesiums renderError-Event ab und laden die
// Seite automatisch neu - die zuletzt gespeicherte Kameraposition (siehe
// saveCameraState/sessionStorage) sorgt dafür, dass der Flug nahtlos an
// (fast) derselben Stelle weitergeht.
function recoverFromFatalRenderError(source, error) {
  console.error(
    `Fataler Render-/WebGL-Context-Fehler (${source}) - lade Seite neu, um den Flug fortzusetzen.`,
    error,
  );
  saveCameraState();
  window.location.reload();
}

function attachRenderErrorRecovery(cesiumInstance, source) {
  cesiumInstance.scene.renderError.addEventListener((scene, error) =>
    recoverFromFatalRenderError(source, error),
  );
  cesiumInstance.canvas?.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    recoverFromFatalRenderError(source, event);
  });
}

attachRenderErrorRecovery(viewer, "viewer");

function loseWebglContext(canvas) {
  const context = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  context?.getExtension("WEBGL_lose_context")?.loseContext();
}

function destroyCesiumInstance(instance) {
  if (!instance || instance.isDestroyed?.()) return;
  loseWebglContext(instance.canvas);
  instance.destroy();
}

function destroyCesiumInstances() {
  destroyCesiumInstance(minimapWidget);
  destroyCesiumInstance(viewer);
}

function hasLayoutSize(element) {
  return element.clientWidth > 0 && element.clientHeight > 0;
}

function syncCesiumRenderLoops() {
  viewer.useDefaultRenderLoop = hasLayoutSize(cesiumContainerEl);
  if (minimapWidget && !minimapWidget.isDestroyed()) {
    minimapWidget.useDefaultRenderLoop = hasLayoutSize(minimapContainerEl);
  }
}

// Schatten/Beleuchtung wirken auf fotorealistischen Meshes deutlich besser
viewer.scene.globe.show = false;
viewer.scene.skyAtmosphere.show = true;

// Cesium wirft einen fatalen "width must be > 0"-Fehler und stoppt komplett,
// falls der Container mal kurz 0x0 groß wird (z.B. Fenster minimiert,
// Tab in den Hintergrund) - stattdessen einfach den Render-Loop
// pausieren/fortsetzen, statt abzustürzen.
window.addEventListener("resize", () => {
  syncCesiumRenderLoops();
});

// --- Letzte Position merken (nur fürs Dev-Comfort) --------------------------
// Damit ein Reload während der Entwicklung nicht jedes Mal wieder den
// kompletten Weltraum-Anflug abspielt, wird die Kameraposition/-lage in
// sessionStorage zwischengespeichert (überlebt Reloads im selben Tab,
// verschwindet beim Schließen des Tabs).
const CAMERA_STATE_KEY = "globexplore_camera_state";
let cameraStateReady = false;

function saveCameraState() {
  if (!cameraStateReady) return;

  try {
    const p = viewer.camera.position;
    sessionStorage.setItem(
      CAMERA_STATE_KEY,
      JSON.stringify({
        x: p.x,
        y: p.y,
        z: p.z,
        heading: viewer.camera.heading,
        pitch,
        roll,
        fovDegrees: Cesium.Math.toDegrees(viewer.camera.frustum.fov),
        cameraTiltDegrees: Cesium.Math.toDegrees(cameraTiltOffset),
        minimapLabelsVisible,
        planeVisible,
        hudHidden,
        contrastPct: colorGradeSettings.contrastAmount * 100,
        saturationPct: colorGradeSettings.saturationAmount * 100,
        brightnessPct: colorGradeSettings.brightnessAmount * 100,
        sepiaPct: colorGradeSettings.sepiaAmount * 100,
        vignettePct: colorGradeSettings.vignetteAmount * 100,
        grainPct: (colorGradeSettings.grainAmount / GRAIN_MAX_INTENSITY) * 100,
        blurPct: colorGradeSettings.blurAmount * 100,
      }),
    );
  } catch {
    // sessionStorage kann z.B. im privaten Modus fehlschlagen - dann eben ohne Persistenz
  }
}

function loadCameraState() {
  try {
    const raw = sessionStorage.getItem(CAMERA_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function isUsableCameraState(state) {
  if (
    !state ||
    ![state.x, state.y, state.z, state.heading, state.pitch, state.roll].every(
      Number.isFinite,
    )
  ) {
    return false;
  }

  const height = Cesium.Cartographic.fromCartesian(
    new Cesium.Cartesian3(state.x, state.y, state.z),
  ).height;
  return Number.isFinite(height) && height <= 1_000_000;
}

// --- Einstellbare Bildfilter (im Pausenmenü, siehe applyContrast() etc.
// weiter unten) --------------------------------------------------------
// Startwerte entsprechen dem bisherigen fest verdrahteten Look (Kontrast
// 1.08, Sättigung 1.12, keine Aufhellung/Abdunklung, kein Sepia,
// Vignette-Minimum 0.88 an den Ecken, kein Filmkorn) - wird per Slider
// verändert und live als Uniform an die cinematicColorGrade-Post-Process-
// Stage unten durchgereicht.
let colorGradeSettings = {
  contrastAmount: 1.08,
  saturationAmount: 1.12,
  brightnessAmount: 1.0,
  sepiaAmount: 0,
  vignetteAmount: 0.12, // 1 - bisheriger fixer Wert 0.88
  grainAmount: 0,
  blurAmount: 0,
};

// --- Dezente "cinematische" Filter über den 3D Tiles ---------------------
// Alle Werte bewusst subtil gehalten, damit es nicht künstlich/übertrieben
// wirkt - eher "etwas mehr Tiefe/Kontrast" als ein auffälliger Filter.
function setupCinematicFilters() {
  // Ambient Occlusion und Bloom sind erstmal deaktiviert: die eingebaute
  // Cesium-AO verträgt sich offenbar nicht sauber mit den Google
  // Photorealistic 3D Tiles (fehlende Normalen-Daten) und erzeugte
  // sichtbare Bild-Artefakte statt eines dezenten Effekts. Nur die eigene,
  // einfache Farbkorrektur unten bleibt aktiv.

  // HDR aus: Cesium liefert dem Custom-Shader sonst Farbwerte weit
  // außerhalb 0..1 (erst am Ende tonegemapped), wodurch unsere einfache
  // Kontrast-/Sättigungsrechnung völlig durchdreht (der "solarisierte"
  // Effekt, den wir vorhin gesehen haben).
  viewer.scene.highDynamicRange = false;

  // MSAA gegen Flimmern/Flackern an dünner, weit entfernter Geometrie
  // (z.B. Bahnschienen, Stromleitungen) - solche Linien fallen bei größerer
  // Entfernung oft unter die Pixelbreite und blinken ohne Kantenglättung
  // bei jeder minimalen Kamerabewegung zwischen sichtbar/unsichtbar.
  viewer.scene.msaaSamples = 4;

  // HINWEIS: viewer.scene.fog wirkt NICHT visuell auf 3D Tiles (nur auf den
  // - bei uns deaktivierten - Globe sowie auf die Screen-Space-Error-
  // Berechnung fürs Tile-Culling). Bekannte Cesium-Einschränkung, siehe
  // https://github.com/CesiumGS/cesium/issues/4196. Wir lassen es trotzdem
  // an: kostet nichts und lässt weit entfernte Tiles etwas gröber/früher
  // aussortieren, was zusätzlich gegen das Kachel-Flackern hilft.
  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.0001;

  // Der eigentliche sichtbare Nebel kommt aus dem eigenen, tiefenbasierten
  // Post-Process-Stage unten (fogPostProcess): er blendet jedes Pixel
  // abhängig von seiner Entfernung zur Kamera Richtung Himmelsfarbe ein.
  // Kaschiert nebenbei genau das Flimmern an dünner, weit entfernter
  // Geometrie (Schienen, Leitungen etc.), das MSAA allein nicht ganz
  // beseitigt - deutlich günstiger als ein echter tiefenabhängiger Blur.
  addDepthFogPostProcess();

  // Eigene, kleine Farbkorrektur: Kontrast/Sättigung/Helligkeit/Sepia/
  // Vignette-Stärke/Filmkorn (alle per Slider im Pausenmenü einstellbar,
  // siehe colorGradeSettings oben), rundet den "Kino"-Look ab.
  viewer.scene.postProcessStages.add(
    new Cesium.PostProcessStage({
      name: "cinematicColorGrade",
      fragmentShader: `
        uniform sampler2D colorTexture;
        uniform float contrastAmount;
        uniform float saturationAmount;
        uniform float brightnessAmount;
        uniform float sepiaAmount;
        uniform float vignetteAmount;
        uniform float grainAmount;
        uniform float blurAmount;
        in vec2 v_textureCoordinates;

        // Einfache Pseudo-Zufallszahl aus einem 2D-Vektor - Standardtrick
        // für GLSL, kein echter Zufall, aber ausreichend gleichverteilt/
        // hochfrequent für Filmkorn.
        float randomFromVec2(vec2 co) {
          return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          // Neun Bildpunkte mitteln: ein leichter, gleichmäßiger Blur ohne
          // zusätzliche Post-Process-Stufe und damit ohne weitere Renderpass-Kosten.
          vec2 blurOffset = vec2(0.004) * blurAmount;
          vec4 color = texture(colorTexture, v_textureCoordinates) * 0.20;
          color += texture(colorTexture, v_textureCoordinates + vec2(blurOffset.x, 0.0)) * 0.10;
          color += texture(colorTexture, v_textureCoordinates - vec2(blurOffset.x, 0.0)) * 0.10;
          color += texture(colorTexture, v_textureCoordinates + vec2(0.0, blurOffset.y)) * 0.10;
          color += texture(colorTexture, v_textureCoordinates - vec2(0.0, blurOffset.y)) * 0.10;
          color += texture(colorTexture, v_textureCoordinates + blurOffset) * 0.10;
          color += texture(colorTexture, v_textureCoordinates - blurOffset) * 0.10;
          color += texture(colorTexture, v_textureCoordinates + vec2(blurOffset.x, -blurOffset.y)) * 0.10;
          color += texture(colorTexture, v_textureCoordinates + vec2(-blurOffset.x, blurOffset.y)) * 0.10;
          color.rgb = clamp(color.rgb, 0.0, 1.0);

          // Kontrast
          color.rgb = clamp((color.rgb - 0.5) * contrastAmount + 0.5, 0.0, 1.0);

          // Sättigung
          float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
          color.rgb = clamp(mix(vec3(gray), color.rgb, saturationAmount), 0.0, 1.0);

          // Sepia: mischt Richtung eines warmen Braun-/Gelbtons, der aus
          // der jeweils EIGENEN Graustufe berechnet wird (statt einer
          // festen Farbe) - so bleiben helle/dunkle Bereiche weiter
          // unterscheidbar, es wirkt wie ein alter Fotofilter statt ein
          // platter Farbstich übers ganze Bild.
          vec3 sepiaTone = gray * vec3(1.15, 0.95, 0.75);
          color.rgb = clamp(mix(color.rgb, sepiaTone, sepiaAmount), 0.0, 1.0);

          // Helligkeit / Abdunkeln
          color.rgb = clamp(color.rgb * brightnessAmount, 0.0, 1.0);

          // Vignette (dunklere Ecken), Stärke per Slider einstellbar -
          // vignetteAmount 0 = keine Abdunklung an den Ecken, 1 = Ecken
          // komplett schwarz.
          vec2 uv = v_textureCoordinates - 0.5;
          float vignette = smoothstep(0.8, 0.35, length(uv));
          color.rgb *= mix(1.0 - vignetteAmount, 1.0, vignette);

          // Filmkorn: pro Pixel und Frame neu berechnetes Rauschen (mit
          // czm_frameNumber als zusätzlichem Seed-Offset, damit es wie
          // echtes Korn flimmert statt als starres Muster übers Bild zu
          // kleben), symmetrisch um 0 addiert.
          if (grainAmount > 0.0) {
            float grainNoise = randomFromVec2(v_textureCoordinates * 1000.0 + vec2(czm_frameNumber));
            color.rgb += (grainNoise - 0.5) * grainAmount;
            color.rgb = clamp(color.rgb, 0.0, 1.0);
          }

          out_FragColor = color;
        }
      `,
      uniforms: {
        contrastAmount: () => colorGradeSettings.contrastAmount,
        saturationAmount: () => colorGradeSettings.saturationAmount,
        brightnessAmount: () => colorGradeSettings.brightnessAmount,
        sepiaAmount: () => colorGradeSettings.sepiaAmount,
        vignetteAmount: () => colorGradeSettings.vignetteAmount,
        grainAmount: () => colorGradeSettings.grainAmount,
        blurAmount: () => colorGradeSettings.blurAmount,
      },
    }),
  );
}

// Tiefenbasierter Nebel als Post-Process-Stage. Anders als
// viewer.scene.fog (siehe Hinweis oben) wirkt das hier tatsächlich auf
// alles, was gerendert wurde - inklusive der Google Photorealistic 3D
// Tiles - weil wir direkt mit der Tiefentextur des fertigen Frames
// arbeiten statt uns auf ein Cesium-internes Fog-Feature zu verlassen,
// das nur für den Globe gebaut ist.
function addDepthFogPostProcess() {
  const fogSettings = {
    // Nebelfarbe: an die Himmelsfarbe angleichen, damit der Übergang zum
    // Horizont nicht wie ein grauer Vorhang wirkt, sondern wie natürlicher
    // Dunst. Bei Bedarf an Tageszeit/Wetter koppeln.
    color: Cesium.Color.fromCssColorString("#b9c9d6"),
    // Dichte fürs quadratisch-exponentielle Fog-Modell, siehe Shader unten.
    // Wirkt auf reale Meter-Distanzen (nicht auf die 0..1-Ellipsoid-Einheit
    // von viewer.scene.fog!) - deshalb ein ganz anderer Wertebereich.
    // Klein anfangen und hochtasten: 0.00003 blendet bei ca. 15-20 km
    // spürbar ein, bei ca. 40 km praktisch komplett zur Nebelfarbe.
    density: 0.00003,
  };

  const fragmentShader = `
    uniform sampler2D colorTexture;
    uniform sampler2D depthTexture;
    uniform vec4 fogColor;
    uniform float fogDensity;
    in vec2 v_textureCoordinates;

    void main() {
      vec4 sceneColor = texture(colorTexture, v_textureCoordinates);
      float depth = czm_unpackDepth(texture(depthTexture, v_textureCoordinates));

      if (depth >= 1.0) {
        // Himmel/nichts gerendert - unverändert durchreichen, kein Nebel.
        out_FragColor = sceneColor;
        return;
      }

      vec4 eyeCoordinate = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
      float dist = -eyeCoordinate.z / eyeCoordinate.w;
      float scalar = dist * fogDensity;
      float fogFactor = 1.0 - exp(-scalar * scalar);
      out_FragColor = vec4(mix(sceneColor.rgb, fogColor.rgb, clamp(fogFactor, 0.0, 1.0)), sceneColor.a);
    }
  `;

  const stage = viewer.scene.postProcessStages.add(
    new Cesium.PostProcessStage({
      name: "depthFog",
      fragmentShader,
      uniforms: {
        fogColor: () => fogSettings.color,
        fogDensity: () => fogSettings.density,
      },
    }),
  );

  return { stage, fogSettings };
}

// Wartet, bis die Kacheln für die aktuelle Kameraposition zumindest grob
// geladen sind. initialTilesLoaded feuert leider oft schon bei der groben
// Root-Kachel, bevor die eigentlich feineren Kacheln überhaupt angefordert
// wurden - deshalb stattdessen auf loadProgress warten, bis nichts mehr
// angefragt/verarbeitet wird UND das eine kurze Weile (quietMs) so bleibt
// (falls direkt danach eine neue Nachlade-Welle für tiefere Details
// losgeht). timeoutMs als Sicherheitsnetz, falls es nie ganz zur Ruhe kommt.
function waitForTilesReady(tileset, { timeoutMs = 8000, quietMs = 600 } = {}) {
  // Kann z.B. nach einem fehlgeschlagenen Tileset-Load (ungültiger/abgelaufener
  // API-Key) undefined sein - dann gibt es nichts abzuwarten.
  if (!tileset) return Promise.resolve();

  cesiumContainerEl.classList.add("tiles-loading");
  return new Promise((resolve) => {
    let settleTimeout;
    let removeListener;

    const overallTimeout = setTimeout(finish, timeoutMs);

    function finish() {
      clearTimeout(settleTimeout);
      clearTimeout(overallTimeout);
      removeListener?.();
      cesiumContainerEl.classList.remove("tiles-loading");
      resolve();
    }

    removeListener = tileset.loadProgress.addEventListener(
      (numberOfPendingRequests, numberOfTilesProcessing) => {
        clearTimeout(settleTimeout);
        if (numberOfPendingRequests === 0 && numberOfTilesProcessing === 0) {
          settleTimeout = setTimeout(finish, quietMs);
        }
      },
    );

    if (tileset.tilesLoaded) {
      settleTimeout = setTimeout(finish, quietMs);
    }
  });
}

// Modulweit verfügbar (nicht nur lokal in loadGoogleTiles), damit
// geocodeAndFlyTo() nach einem Orts-Sprung ebenfalls auf die frisch
// geladenen Kacheln der neuen Position warten kann.
let tileset;

// Kleiner Wrapper um die /api/geocode-Route (siehe functions/api/geocode.js) -
// wird sowohl von der Ortssuche (geocodeAndFlyTo) als auch vom zufälligen
// Startort (loadGoogleTiles) genutzt.
async function fetchGeocode(query) {
  const url = `/api/geocode?q=${encodeURIComponent(query)}`;
  const response = await fetch(url);
  return response.json();
}

// Zufälligen Eintrag aus derselben Spot-Liste wählen, die auch der
// "3D-Spots"-Tab im Suchpanel nutzt (google_earth_3d_locations_by_country.json,
// oben als spotsByCountry importiert). "Entire country ..."-Einträge (z.B.
// Monaco, Vatikanstadt) lassen sich nicht direkt geocodieren - siehe auch
// den Klick-Handler in renderSpotList() weiter unten - deshalb hier
// ebenfalls durch den Ländernamen ersetzen.
function pickRandomSpotQuery() {
  const countries = Object.keys(spotsByCountry);
  const country = countries[Math.floor(Math.random() * countries.length)];
  const names = spotsByCountry[country];
  const name = names[Math.floor(Math.random() * names.length)];
  return /^entire country/i.test(name) ? country : name;
}

async function loadGoogleTiles() {
  try {
    tileset = await Cesium.createGooglePhotorealistic3DTileset();
    viewer.scene.primitives.add(tileset);
    setupCinematicFilters();

    const savedState = loadCameraState();
    const usableSavedState = isUsableCameraState(savedState)
      ? savedState
      : null;
    let destination;
    let orientation;
    let readyStatusText;

    if (usableSavedState) {
      destination = new Cesium.Cartesian3(
        usableSavedState.x,
        usableSavedState.y,
        usableSavedState.z,
      );
      orientation = {
        heading: usableSavedState.heading,
        pitch: usableSavedState.pitch,
        roll: usableSavedState.roll,
      };
      pitch = usableSavedState.pitch;
      pitchRaw = usableSavedState.pitch;
      roll = usableSavedState.roll;
      rollRaw = usableSavedState.roll;
      rollLevelBlend = 0;
      if (typeof usableSavedState.fovDegrees === "number")
        applyFov(usableSavedState.fovDegrees);
      if (typeof usableSavedState.cameraTiltDegrees === "number")
        applyCameraTilt(usableSavedState.cameraTiltDegrees);
      if (typeof usableSavedState.minimapLabelsVisible === "boolean")
        applyMinimapLabelsVisible(usableSavedState.minimapLabelsVisible);
      if (typeof usableSavedState.planeVisible === "boolean")
        applyPlaneVisible(usableSavedState.planeVisible);
      if (typeof usableSavedState.hudHidden === "boolean")
        applyHudHidden(usableSavedState.hudHidden);
      if (Number.isFinite(usableSavedState.contrastPct))
        applyContrast(usableSavedState.contrastPct);
      if (Number.isFinite(usableSavedState.saturationPct))
        applySaturation(usableSavedState.saturationPct);
      if (Number.isFinite(usableSavedState.brightnessPct))
        applyBrightness(usableSavedState.brightnessPct);
      if (Number.isFinite(usableSavedState.sepiaPct))
        applySepia(usableSavedState.sepiaPct);
      if (Number.isFinite(usableSavedState.vignettePct))
        applyVignette(usableSavedState.vignettePct);
      if (Number.isFinite(usableSavedState.grainPct))
        applyGrain(usableSavedState.grainPct);
      if (Number.isFinite(usableSavedState.blurPct))
        applyBlur(usableSavedState.blurPct);
      readyStatusText = "Weltdaten geladen (letzte Position wiederhergestellt)";
    } else {
      // Kein gespeicherter Stand: statt immer derselben Stadt einen
      // zufälligen Ort aus der 3D-Spots-Liste als Startort verwenden.
      // Schlägt das Geocoding fehl (Netzwerk, kein Treffer o.ä.), auf
      // Berlin zurückfallen statt den Start abzubrechen.
      let destLon = 13.405;
      let destLat = 52.52;
      let placeLabel = null;
      try {
        const data = await fetchGeocode(pickRandomSpotQuery());
        if (data.status === "OK") {
          destLon = data.lng;
          destLat = data.lat;
          placeLabel = data.formatted_address;
        }
      } catch (err) {
        console.error(err);
      }

      // Bodenhöhe an der Zielposition abfragen (Tileset ist schon in der
      // Szene, siehe oben), damit man z.B. in Bergregionen nicht im Boden
      // startet - dieselbe Technik wie beim Orts-Sprung über die Suche.
      const groundHeight = await getGroundHeight(destLon, destLat);
      destination = Cesium.Cartesian3.fromDegrees(
        destLon,
        destLat,
        groundHeight + 300,
      );
      orientation = { heading: Cesium.Math.toRadians(0), pitch: 0, roll: 0 };
      readyStatusText = placeLabel
        ? `Weltdaten geladen (${placeLabel})`
        : "Weltdaten geladen";
    }

    // Kamera schon jetzt (unsichtbar hinter dem Loading-Overlay) an die
    // Zielposition setzen, damit initialTilesLoaded die Kacheln für den
    // tatsächlichen Zielausschnitt abwartet statt für die Standardansicht.
    viewer.camera.setView({ destination, orientation });
    cameraStateReady = true;
    await waitForTilesReady(tileset);
    loadingOverlayEl.classList.add("hidden");

    // Wie nach der Ortssuche (geocodeAndFlyTo) auch beim initialen
    // Spielstart direkt mit 125 km/h starten, statt stehend (speed = 0)
    // zu beginnen - sowohl bei wiederhergestellter Position als auch beim
    // zufälligen Startort.
    speed = 125 / 3.6; // 125 km/h in m/s

    setStatus(readyStatusText);
    setStatusVisible(false);
    maybeShowControlsHelpOnce();
  } catch (err) {
    setStatus("Fehler beim Laden der 3D Tiles - API-Key prüfen");
    loadingOverlayEl.classList.add("hidden");
    console.error(err);
  }
}

loadGoogleTiles();

// --- Minimap (unten rechts) --------------------------------------------
// Eigenes, schlankes CesiumWidget (keine Toolbar/Steuerung nötig) mit
// OpenStreetMap-Kacheln statt der Google Photorealistic 3D Tiles - dafür
// wird kein zusätzlicher API-Key gebraucht. Fest Norden oben, die Kamera
// wird pro Frame auf die aktuelle Spielerposition zentriert; die
// Spielerposition selbst ist einfach der feste rote Punkt in der Mitte
// (siehe #minimap-marker in style.css).
minimapWidget = new Cesium.CesiumWidget("minimap", {
  sceneMode: Cesium.SceneMode.SCENE2D,
  // Cesiums 2D-Modus ist standardmäßig auf endloses Scrollen eingestellt
  // und ignoriert dabei Heading-Änderungen - für eine drehbare Karte muss
  // das hier explizit umgestellt werden.
  mapMode2D: Cesium.MapMode2D.ROTATE,
  baseLayer: false,
  terrain: undefined,
  animation: false,
  timeline: false,
  showRenderLoopErrors: false,
});
attachRenderErrorRecovery(minimapWidget, "minimap");
// Zwei austauschbare Kachelquellen: Standard-OSM (mit Beschriftungen, wie
// bisher) und CartoDB Voyager ohne Beschriftungen (visuell am nächsten an
// OSM, aber ohne eingebrannten Text) - umschaltbar über den Menü-Switch.
// Beide brauchen keinen eigenen API-Key.
function createMinimapImageryProvider(labelsVisible) {
  return labelsVisible
    ? new Cesium.OpenStreetMapImageryProvider({
        url: "https://tile.openstreetmap.org/",
      })
    : new Cesium.UrlTemplateImageryProvider({
        url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
        subdomains: ["a", "b", "c", "d"],
        credit: "© OpenStreetMap contributors © CARTO",
      });
}

let minimapLabelsVisible = true;
minimapWidget.scene.imageryLayers.addImageryProvider(
  createMinimapImageryProvider(minimapLabelsVisible),
);
minimapWidget.scene.globe.baseColor = Cesium.Color.BLACK;
// Keine eigene Maus-/Touch-Steuerung auf der Minimap
minimapWidget.scene.screenSpaceCameraController.enableInputs = false;
// Volle Bildschirmauflösung (statt CSS-Pixel) für ein schärferes Bild,
// besonders auf Retina-/High-DPI-Displays
minimapWidget.resolutionScale = window.devicePixelRatio || 1;

const minimapMarkerEl = document.getElementById("minimap-marker");

const MINIMAP_HEIGHT = 2500; // Meter - steuert den Zoomlevel der Minimap (näher = schärfer bei Esri-Satellit)

function updateMinimap() {
  if (
    !minimapWidget ||
    minimapWidget.isDestroyed() ||
    !hasLayoutSize(minimapContainerEl)
  )
    return;

  const carto = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  // Norden fest oben - die Karte selbst dreht sich nicht, stattdessen wird
  // der Marker unten auf die aktuelle Flugrichtung gedreht.
  minimapWidget.camera.setView({
    destination: Cesium.Cartesian3.fromRadians(
      carto.longitude,
      carto.latitude,
      MINIMAP_HEIGHT,
    ),
    orientation: { heading: 0 },
  });

  const headingDeg = Cesium.Math.toDegrees(viewer.camera.heading);
  minimapMarkerEl.style.transform = `rotate(${headingDeg}deg)`;
}

const minimapLabelsToggle = document.getElementById("minimap-labels-toggle");

function applyMinimapLabelsVisible(visible) {
  minimapLabelsVisible = visible;
  minimapLabelsToggle.checked = visible;
  minimapWidget.scene.imageryLayers.removeAll();
  minimapWidget.scene.imageryLayers.addImageryProvider(
    createMinimapImageryProvider(visible),
  );
}

minimapLabelsToggle.addEventListener("change", () => {
  applyMinimapLabelsVisible(minimapLabelsToggle.checked);
  saveCameraState();
});

window.addEventListener("pagehide", destroyCesiumInstances, { once: true });

if (import.meta.hot) {
  import.meta.hot.dispose(destroyCesiumInstances);
}

// --- Steuerungs-Hilfe-Panel -----------------------------------------------
// Gleiche Optik wie das Pausenmenü, zeigt aber nur einmalig beim allerersten
// Start eine kurze Legende der Tastenbelegung. "Gesehen"-Status landet in
// localStorage (wie FAVORITES_KEY), überlebt also auch neue Sessions.
const CONTROLS_HELP_SEEN_KEY = "globexplore_controls_help_seen";
const controlsPanel = document.getElementById("controls-panel");
const controlsPanelCloseBtn = document.getElementById("controls-panel-close");
const controlsPanelStartBtn = document.getElementById(
  "controls-panel-start-button",
);

function hasSeenControlsHelp() {
  try {
    return localStorage.getItem(CONTROLS_HELP_SEEN_KEY) === "1";
  } catch {
    // localStorage kann z.B. im privaten Modus fehlschlagen - dann eben
    // bei jedem Start einmal anzeigen statt abzustürzen.
    return false;
  }
}

function closeControlsHelp() {
  controlsPanel.classList.remove("visible");
  try {
    localStorage.setItem(CONTROLS_HELP_SEEN_KEY, "1");
  } catch {
    // s.o. - Persistenz ist hier nur ein Nice-to-have.
  }
}

function maybeShowControlsHelpOnce() {
  if (hasSeenControlsHelp()) return;
  controlsPanel.classList.add("visible");
  controlsPanelCloseBtn.focus();
}

controlsPanelCloseBtn.addEventListener("click", closeControlsHelp);
controlsPanelStartBtn.addEventListener("click", closeControlsHelp);

const controlsHelpButton = document.getElementById("controls-help-button");
controlsHelpButton.addEventListener("click", () => {
  if (isPaused) togglePause();
  controlsPanel.classList.add("visible");
  controlsPanelCloseBtn.focus();
});

// --- Künstlicher Horizont ------------------------------------------------
// Zeigt die tatsächliche Fluglage (pitch/roll der Steuerung), bewusst OHNE
// den Kamera-Blickwinkel-Offset (siehe cameraTiltOffset weiter unten) - das
// Instrument soll die Lage des "Fluggeräts" anzeigen, nicht wohin die
// (davon unabhängige) Kamera gerade schaut.
const horizonBallEl = document.getElementById("horizon-ball");
const horizonRollPointerEl = document.getElementById("horizon-roll-pointer");
const HORIZON_PX_PER_DEGREE = 3; // Pixel Verschiebung der Kugel pro Grad Pitch

function updateHorizon() {
  const pitchDeg = Cesium.Math.toDegrees(pitch);
  const rollDeg = Cesium.Math.toDegrees(roll);

  // Reihenfolge in der CSS-transform-Property wird von rechts nach links
  // angewendet: erst die Verschiebung (im noch unrotierten Koordinaten-
  // system der Kugel), danach die Rotation um die Fenstermitte - wie bei
  // einem echten künstlichen Horizont, bei dem sich die Kugel sowohl neigt
  // als auch dreht. Nase hoch (positiver Pitch) -> mehr Himmel sichtbar ->
  // Kugel nach unten verschieben.
  horizonBallEl.style.transform = `rotate(${-rollDeg}deg) translateY(${pitchDeg * HORIZON_PX_PER_DEGREE}px)`;

  // Zeiger am Rand dreht sich mit der tatsächlichen Schräglage (nicht
  // gegenläufig wie die Kugel selbst) - zeigt intuitiv, in welche Richtung
  // gerade gekurvt/gekippt wird.
  horizonRollPointerEl.style.transform = `rotate(${rollDeg}deg)`;
}

// --- Ortssuche (nur im Pausenmodus) -------------------------------------
// Nutzt Googles Geocoding API mit demselben API-Key wie die 3D Tiles -
// dafür muss die "Geocoding API" für den Key zusätzlich im Google Cloud
// Console freigeschaltet sein (separates API-Flag).
const searchPanel = document.getElementById("search-panel");
const searchPanelCloseBtn = document.getElementById("search-panel-close");
const searchInput = document.getElementById("search-input");
const searchButton = document.getElementById("search-button");
const searchStatusEl = document.getElementById("search-status");

// --- Sichtfeld / FOV (nur im Pausenmodus einstellbar) -------------------
// Cesium erwartet den FOV in Radiant (vertikaler Öffnungswinkel des
// PerspectiveFrustum) - im UI wird stattdessen mit Grad gearbeitet, das
// ist für Nutzer:innen intuitiver.
const FOV_MIN_DEG = 30;
const FOV_MAX_DEG = 100;
const FOV_DEFAULT_DEG = 70;

const fovSlider = document.getElementById("fov-slider");
const fovValueEl = document.getElementById("fov-value");

function applyFov(deg) {
  const clamped = Cesium.Math.clamp(deg, FOV_MIN_DEG, FOV_MAX_DEG);
  viewer.camera.frustum.fov = Cesium.Math.toRadians(clamped);
  fovSlider.value = clamped;
  fovValueEl.textContent = `${Math.round(clamped)}°`;
}

fovSlider.min = FOV_MIN_DEG;
fovSlider.max = FOV_MAX_DEG;
applyFov(FOV_DEFAULT_DEG);

fovSlider.addEventListener("input", () => {
  applyFov(Number(fovSlider.value));
  saveCameraState();
});

// --- Kamera-Blickwinkel / Gimbal-Neigung (nur im Pausenmodus einstellbar) -
// Wie bei einer FPV-Drohne: die Kamera neigt sich zusätzlich nach oben/unten,
// die eigentliche Flugsteuerung (Pitch/Roll/Heading, Bewegungsrichtung) bleibt
// davon komplett unberührt. Der Offset wird erst NACH camera.moveForward()
// rein fürs Rendering auf die Blickrichtung addiert (siehe Tick-Handler unten) -
// die Drohne fliegt also weiter entlang ihres normalen Flugpfads, nur die
// "Kamera" schaut zusätzlich hoch/runter.
const CAMERA_TILT_MIN_DEG = -60; // maximal nach unten
const CAMERA_TILT_MAX_DEG = 30; // maximal nach oben
const CAMERA_TILT_DEFAULT_DEG = -8;
// Flug-Pitch (bis PITCH_MAX) + Kamera-Tilt-Offset addiert sich - hart
// gedeckelt knapp unter +-90°, damit die Kamera nie "durchschlägt"/kippt.
const RENDER_PITCH_LIMIT = Cesium.Math.toRadians(89);
function clampedRenderPitch(offset) {
  return Cesium.Math.clamp(
    pitch + offset,
    -RENDER_PITCH_LIMIT,
    RENDER_PITCH_LIMIT,
  );
}

const cameraTiltSlider = document.getElementById("camera-tilt-slider");
const cameraTiltValueEl = document.getElementById("camera-tilt-value");
let cameraTiltOffset = 0; // Radiant, wird im Tick-Handler verwendet

function applyCameraTilt(deg) {
  const clamped = Cesium.Math.clamp(
    deg,
    CAMERA_TILT_MIN_DEG,
    CAMERA_TILT_MAX_DEG,
  );
  cameraTiltOffset = Cesium.Math.toRadians(clamped);
  cameraTiltSlider.value = clamped;
  cameraTiltValueEl.textContent = `${Math.round(clamped)}°`;
}
cameraTiltSlider.min = CAMERA_TILT_MIN_DEG;
cameraTiltSlider.max = CAMERA_TILT_MAX_DEG;
applyCameraTilt(CAMERA_TILT_DEFAULT_DEG);

cameraTiltSlider.addEventListener("input", () => {
  applyCameraTilt(Number(cameraTiltSlider.value));
  saveCameraState();
  // Direkt sichtbar auch während der Pause (Tick-Handler läuft dann nicht):
  viewer.camera.setView({
    destination: viewer.camera.position,
    orientation: {
      heading: viewer.camera.heading,
      pitch: clampedRenderPitch(cameraTiltOffset),
      roll,
    },
  });
  updatePlaneModelMatrix();
});

// --- Flugzeug-Overlay (kein eigenständiges Objekt, nur eingeblendet) ----
// Kein echtes Weltobjekt mit eigener Position/Physik, sondern eine reine
// Sicht-Deko: das Modell wird jeden Frame relativ zur aktuellen Kamera neu
// platziert (etwas davor und darunter) und mit der Kamera-Ausrichtung
// mitgedreht - dadurch "klebt" es fix an der gleichen Stelle im Bild, so
// als würde man von einem Cockpit/einer Drohnen-Nase aus schauen.
const PLANE_MODEL_URL = "/models/cockpit.glb";
const PLANE_FORWARD_OFFSET = 43; // Meter vor der Kamera
const PLANE_DOWN_OFFSET = 42; // Meter unterhalb der Kamera
const PLANE_RIGHT_OFFSET = 23; // Meter seitlich (0 = mittig)
const PLANE_SCALE = 0.60; // ggf. anpassen, falls das Modell zu groß/klein ist
// Abdunkelung: 0 = Originalfarben, 1 = komplett schwarz. Wird per
// colorBlendMode MULTIPLY mit den Modellfarben verrechnet.
const PLANE_DARKEN_AMOUNT = 0.5;
// Falls das Modell nicht in Blickrichtung "nach vorne" zeigt (glTF-Konvention:
// Front = lokale -Z-Achse), kann hier ein zusätzlicher Dreh-Offset in Grad
// ergänzt werden (Gieren/Neigen/Rollen relativ zur Kamera).
const PLANE_YAW_OFFSET_DEG = 0;
const PLANE_PITCH_OFFSET_DEG = -90;
const PLANE_ROLL_OFFSET_DEG = -90;

let planeModel = null;
let planeVisible = false;

const planeVisibleToggle = document.getElementById("plane-visible-toggle");

const planeScratchPosition = new Cesium.Cartesian3();
const planeScratchOffset = new Cesium.Cartesian3();
const planeScratchRotation = new Cesium.Matrix3();
const planeScratchOffsetRotation = new Cesium.Matrix3();
const planeExtraRotation = Cesium.Matrix3.fromHeadingPitchRoll(
  new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(PLANE_YAW_OFFSET_DEG),
    Cesium.Math.toRadians(PLANE_PITCH_OFFSET_DEG),
    Cesium.Math.toRadians(PLANE_ROLL_OFFSET_DEG),
  ),
  new Cesium.Matrix3(),
);

function updatePlaneModelMatrix() {
  if (!planeModel) return;

  const camera = viewer.camera;

  // Position: Kamera-Position + Versatz entlang der Kamera-eigenen Achsen
  // (davor / darunter / seitlich).
  Cesium.Cartesian3.clone(camera.positionWC, planeScratchPosition);
  Cesium.Cartesian3.multiplyByScalar(
    camera.direction,
    PLANE_FORWARD_OFFSET,
    planeScratchOffset,
  );
  Cesium.Cartesian3.add(
    planeScratchPosition,
    planeScratchOffset,
    planeScratchPosition,
  );
  Cesium.Cartesian3.multiplyByScalar(
    camera.up,
    -PLANE_DOWN_OFFSET,
    planeScratchOffset,
  );
  Cesium.Cartesian3.add(
    planeScratchPosition,
    planeScratchOffset,
    planeScratchPosition,
  );
  if (PLANE_RIGHT_OFFSET !== 0) {
    Cesium.Cartesian3.multiplyByScalar(
      camera.right,
      PLANE_RIGHT_OFFSET,
      planeScratchOffset,
    );
    Cesium.Cartesian3.add(
      planeScratchPosition,
      planeScratchOffset,
      planeScratchPosition,
    );
  }

  // Ausrichtung: lokale Achsen des Modells (glTF: X=rechts, Y=oben,
  // Z=-Blickrichtung) auf die Kamera-Achsen abbilden, damit das Modell immer
  // "vorwärts" zur Kamera zeigt, egal wie geflogen wird.
  Cesium.Matrix3.setColumn(
    planeScratchRotation,
    0,
    camera.right,
    planeScratchRotation,
  );
  Cesium.Matrix3.setColumn(
    planeScratchRotation,
    1,
    camera.up,
    planeScratchRotation,
  );
  const negDirection = Cesium.Cartesian3.negate(
    camera.direction,
    new Cesium.Cartesian3(),
  );
  Cesium.Matrix3.setColumn(
    planeScratchRotation,
    2,
    negDirection,
    planeScratchRotation,
  );
  Cesium.Matrix3.multiply(
    planeScratchRotation,
    planeExtraRotation,
    planeScratchOffsetRotation,
  );

  const modelMatrix = Cesium.Matrix4.fromRotationTranslation(
    planeScratchOffsetRotation,
    planeScratchPosition,
    new Cesium.Matrix4(),
  );
  if (PLANE_SCALE !== 1) {
    Cesium.Matrix4.multiplyByUniformScale(
      modelMatrix,
      PLANE_SCALE,
      modelMatrix,
    );
  }
  planeModel.modelMatrix = modelMatrix;
}

// Wenn das Flugzeug-Overlay sichtbar ist, ist der Blickwinkel fest auf
// diesen Wert gesetzt (passend zur Cockpit-Perspektive) und der Tilt-Regler
// wird ausgeblendet, da er in dem Zustand ohnehin wirkungslos wäre.
const PLANE_FIXED_TILT_DEG = -3;
const cameraTiltRow = document.getElementById("camera-tilt-row");

function applyPlaneVisible(visible) {
  planeVisible = visible;
  planeVisibleToggle.checked = visible;
  if (planeModel) planeModel.show = visible;
  cameraTiltRow.hidden = visible;
  if (visible) applyCameraTilt(PLANE_FIXED_TILT_DEG);
}

planeVisibleToggle.addEventListener("change", () => {
  applyPlaneVisible(planeVisibleToggle.checked);
  saveCameraState();
});
applyPlaneVisible(planeVisible); // Initialzustand (Regler-Sichtbarkeit + Tilt)

// "Nur Landschaft"-Schalter - blendet HUD, Speed/Höhe, Minimap, Horizont
// und die Google-Attribution aus (siehe body.hide-hud-Regel in style.css).
let hudHidden = false;
const hideHudToggle = document.getElementById("hide-hud-toggle");

function applyHudHidden(hidden) {
  hudHidden = hidden;
  hideHudToggle.checked = hidden;
  document.body.classList.toggle("hide-hud", hidden);
}

hideHudToggle.addEventListener("change", () => {
  applyHudHidden(hideHudToggle.checked);
  saveCameraState();
});
applyHudHidden(hudHidden);

async function loadPlaneModel() {
  try {
    planeModel = await Cesium.Model.fromGltfAsync({
      url: PLANE_MODEL_URL,
      // Kein Höhen-Clamping/Terrain-Bezug - die Position wird jeden Frame
      // selbst gesetzt (siehe updatePlaneModelMatrix), daher hier keine
      // scene-Referenzierung für Höhen-Interpretation nötig.
    });
    planeModel.show = planeVisible;
    const shade = 1 - PLANE_DARKEN_AMOUNT;
    planeModel.color = new Cesium.Color(shade, shade, shade, 1);
    planeModel.colorBlendMode = Cesium.ColorBlendMode.HIGHLIGHT;
    viewer.scene.primitives.add(planeModel);
    updatePlaneModelMatrix();
  } catch (err) {
    console.error("Flugzeug-Modell konnte nicht geladen werden:", err);
  }
}
loadPlaneModel();

// --- Bildfilter (nur im Pausenmodus einstellbar) ------------------------
// Vier Regler auf dieselbe cinematicColorGrade-Post-Process-Stage (siehe
// setupCinematicFilters oben) - wirken als Post-Process direkt auf den
// fertigen Frame, brauchen also (anders als z.B. der Kamera-Tilt) keinen
// eigenen Re-Render-Aufruf beim Ändern, um während der Pause sichtbar zu
// sein.
const CONTRAST_MIN_PCT = 80;
const CONTRAST_MAX_PCT = 130;
const CONTRAST_DEFAULT_PCT = 105;

const SATURATION_MIN_PCT = 70;
const SATURATION_MAX_PCT = 140;
const SATURATION_DEFAULT_PCT = 110;

const BRIGHTNESS_MIN_PCT = 60;
const BRIGHTNESS_MAX_PCT = 120;
const BRIGHTNESS_DEFAULT_PCT = 95;

const SEPIA_MIN_PCT = 0;
const SEPIA_MAX_PCT = 100;
const SEPIA_DEFAULT_PCT = 5;

// Vignette: Prozentwert = Abdunklung an den Ecken direkt in vignetteAmount
// (siehe Shader oben, 0% = kein Vignetting, 60% = Ecken auf 40% Helligkeit
// abgedunkelt). Default 12% entspricht dem bisherigen fixen Wert (0.88).
const VIGNETTE_MIN_PCT = 0;
const VIGNETTE_MAX_PCT = 60;
const VIGNETTE_DEFAULT_PCT = 15;

// Filmkorn: 0% = aus (Standard), 100% = deutlich sichtbares Korn. Wird im
// Shader auf eine maximale Rauschamplitude von 0.15 gemappt (siehe
// applyGrain unten) - höher wirkt schnell wie Bildrauschen statt Filmkorn.
const GRAIN_MIN_PCT = 0;
const GRAIN_MAX_PCT = 100;
const GRAIN_DEFAULT_PCT = 8;
const GRAIN_MAX_INTENSITY = 0.15;

const BLUR_MIN_PCT = 0;
const BLUR_MAX_PCT = 100;
const BLUR_DEFAULT_PCT = 5;

const contrastSlider = document.getElementById("contrast-slider");
const contrastValueEl = document.getElementById("contrast-value");
const saturationSlider = document.getElementById("saturation-slider");
const saturationValueEl = document.getElementById("saturation-value");
const brightnessSlider = document.getElementById("brightness-slider");
const brightnessValueEl = document.getElementById("brightness-value");
const sepiaSlider = document.getElementById("sepia-slider");
const sepiaValueEl = document.getElementById("sepia-value");
const vignetteSlider = document.getElementById("vignette-slider");
const vignetteValueEl = document.getElementById("vignette-value");
const grainSlider = document.getElementById("grain-slider");
const grainValueEl = document.getElementById("grain-value");
const blurSlider = document.getElementById("blur-slider");
const blurValueEl = document.getElementById("blur-value");

function applyContrast(pct) {
  const clamped = Cesium.Math.clamp(pct, CONTRAST_MIN_PCT, CONTRAST_MAX_PCT);
  colorGradeSettings.contrastAmount = clamped / 100;
  contrastSlider.value = clamped;
  contrastValueEl.textContent = `${Math.round(clamped)}%`;
}

function applySaturation(pct) {
  const clamped = Cesium.Math.clamp(
    pct,
    SATURATION_MIN_PCT,
    SATURATION_MAX_PCT,
  );
  colorGradeSettings.saturationAmount = clamped / 100;
  saturationSlider.value = clamped;
  saturationValueEl.textContent = `${Math.round(clamped)}%`;
}

function applyBrightness(pct) {
  const clamped = Cesium.Math.clamp(
    pct,
    BRIGHTNESS_MIN_PCT,
    BRIGHTNESS_MAX_PCT,
  );
  colorGradeSettings.brightnessAmount = clamped / 100;
  brightnessSlider.value = clamped;
  brightnessValueEl.textContent = `${Math.round(clamped)}%`;
}

function applySepia(pct) {
  const clamped = Cesium.Math.clamp(pct, SEPIA_MIN_PCT, SEPIA_MAX_PCT);
  colorGradeSettings.sepiaAmount = clamped / 100;
  sepiaSlider.value = clamped;
  sepiaValueEl.textContent = `${Math.round(clamped)}%`;
}

function applyVignette(pct) {
  const clamped = Cesium.Math.clamp(pct, VIGNETTE_MIN_PCT, VIGNETTE_MAX_PCT);
  colorGradeSettings.vignetteAmount = clamped / 100;
  vignetteSlider.value = clamped;
  vignetteValueEl.textContent = `${Math.round(clamped)}%`;
}

function applyGrain(pct) {
  const clamped = Cesium.Math.clamp(pct, GRAIN_MIN_PCT, GRAIN_MAX_PCT);
  colorGradeSettings.grainAmount = (clamped / 100) * GRAIN_MAX_INTENSITY;
  grainSlider.value = clamped;
  grainValueEl.textContent = `${Math.round(clamped)}%`;
}

function applyBlur(pct) {
  const clamped = Cesium.Math.clamp(pct, BLUR_MIN_PCT, BLUR_MAX_PCT);
  colorGradeSettings.blurAmount = clamped / 100;
  blurSlider.value = clamped;
  blurValueEl.textContent = `${Math.round(clamped)}%`;
}

contrastSlider.min = CONTRAST_MIN_PCT;
contrastSlider.max = CONTRAST_MAX_PCT;
applyContrast(CONTRAST_DEFAULT_PCT);
saturationSlider.min = SATURATION_MIN_PCT;
saturationSlider.max = SATURATION_MAX_PCT;
applySaturation(SATURATION_DEFAULT_PCT);
brightnessSlider.min = BRIGHTNESS_MIN_PCT;
brightnessSlider.max = BRIGHTNESS_MAX_PCT;
applyBrightness(BRIGHTNESS_DEFAULT_PCT);
sepiaSlider.min = SEPIA_MIN_PCT;
sepiaSlider.max = SEPIA_MAX_PCT;
applySepia(SEPIA_DEFAULT_PCT);
vignetteSlider.min = VIGNETTE_MIN_PCT;
vignetteSlider.max = VIGNETTE_MAX_PCT;
applyVignette(VIGNETTE_DEFAULT_PCT);
grainSlider.min = GRAIN_MIN_PCT;
grainSlider.max = GRAIN_MAX_PCT;
applyGrain(GRAIN_DEFAULT_PCT);
blurSlider.min = BLUR_MIN_PCT;
blurSlider.max = BLUR_MAX_PCT;
applyBlur(BLUR_DEFAULT_PCT);

contrastSlider.addEventListener("input", () => {
  applyContrast(Number(contrastSlider.value));
  saveCameraState();
});
saturationSlider.addEventListener("input", () => {
  applySaturation(Number(saturationSlider.value));
  saveCameraState();
});
brightnessSlider.addEventListener("input", () => {
  applyBrightness(Number(brightnessSlider.value));
  saveCameraState();
});
sepiaSlider.addEventListener("input", () => {
  applySepia(Number(sepiaSlider.value));
  saveCameraState();
});
vignetteSlider.addEventListener("input", () => {
  applyVignette(Number(vignetteSlider.value));
  saveCameraState();
});
grainSlider.addEventListener("input", () => {
  applyGrain(Number(grainSlider.value));
  saveCameraState();
});
blurSlider.addEventListener("input", () => {
  applyBlur(Number(blurSlider.value));
  saveCameraState();
});

// "Zurücksetzen"-Button: stellt den ursprünglichen, fest verdrahteten
// "kinematischen" Look wieder her (Kontrast 108%, Sättigung 112%,
// Vignette 12% - dieselben Werte wie CONTRAST_DEFAULT_PCT/
// SATURATION_DEFAULT_PCT/VIGNETTE_DEFAULT_PCT oben), Helligkeit/Sepia/
// Filmkorn auf ihren jeweiligen Aus-Zustand (100%/0%/0%).
const filtersResetButton = document.getElementById("filters-reset-button");
filtersResetButton.addEventListener("click", () => {
  applyContrast(CONTRAST_DEFAULT_PCT);
  applySaturation(SATURATION_DEFAULT_PCT);
  applyBrightness(BRIGHTNESS_DEFAULT_PCT);
  applySepia(SEPIA_DEFAULT_PCT);
  applyVignette(VIGNETTE_DEFAULT_PCT);
  applyGrain(GRAIN_DEFAULT_PCT);
  applyBlur(BLUR_DEFAULT_PCT);
  saveCameraState();
});

async function getGroundHeight(lon, lat) {
  const cartographic = Cesium.Cartographic.fromDegrees(lon, lat);
  try {
    // Fragt die Höhe direkt aus den geladenen 3D Tiles ab (lädt bei Bedarf
    // selbst die nötigen Kacheln nach, auch abseits des aktuellen
    // Kamerablicks) - kein externer API-Call nötig.
    const results = await viewer.scene.sampleHeightMostDetailed([cartographic]);
    if (results && results[0] && results[0].height !== undefined) {
      return results[0].height;
    }
  } catch (err) {
    console.error(err);
  }
  return 0; // Fallback: Meeresspiegel, falls an der Stelle nichts samplebar ist
}

async function geocodeAndFlyTo(query) {
  if (!query.trim()) return;
  searchStatusEl.textContent = "Suche…";
  // Formularfelder/Tabs ausblenden, solange Suche/Anflug/Kacheln-Laden
  // läuft - während dieser Zeit ergibt eine erneute Eingabe ohnehin keinen
  // Sinn (siehe #search-panel.searching in style.css).
  searchPanel.classList.add("searching");
  try {
    // Läuft über die eigene /api/geocode-Route (Cloudflare Pages Function),
    // die den Google-Geocoding-Key serverseitig hält - der Key landet damit
    // nie im Client-Bundle. Siehe functions/api/geocode.js.
    const url = `/api/geocode?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK") {
      searchStatusEl.textContent = `Kein Ergebnis gefunden (${data.status}).`;
      searchPanel.classList.remove("searching"); // erneute Eingabe erlauben
      return;
    }

    const { lat, lng } = data;
    searchStatusEl.textContent = `Gefunden: ${data.formatted_address}`;

    // Startpunkt 3km südlich des Ziels (statt direkt darüber), Blickrichtung
    // Norden (heading 0) - man fliegt den Ort so quasi an, statt schon
    // mittendrin zu starten. Erst die Position (unabhängig von der Höhe)
    // bestimmen, dann die echte Bodenhöhe dort abfragen.
    const targetPositionRef = Cesium.Cartesian3.fromDegrees(lng, lat, 0);
    const targetEnuFrame =
      Cesium.Transforms.eastNorthUpToFixedFrame(targetPositionRef);
    const APPROACH_DISTANCE = 3000; // Meter
    const APPROACH_HEIGHT_ABOVE_GROUND = 200; // Meter
    const startPositionRef = Cesium.Matrix4.multiplyByPoint(
      targetEnuFrame,
      new Cesium.Cartesian3(0, -APPROACH_DISTANCE, 0), // lokal: -Y = südlich vom Ziel
      new Cesium.Cartesian3(),
    );
    const startCarto = Cesium.Cartographic.fromCartesian(startPositionRef);
    const startLon = Cesium.Math.toDegrees(startCarto.longitude);
    const startLat = Cesium.Math.toDegrees(startCarto.latitude);

    const groundHeight = await getGroundHeight(startLon, startLat);
    const startPosition = Cesium.Cartesian3.fromDegrees(
      startLon,
      startLat,
      groundHeight + APPROACH_HEIGHT_ABOVE_GROUND,
    );

    // WICHTIG: Erst auf das Ende der flyTo-Animation warten, dann erst auf
    // die Tiles. Cesium fordert Kacheln anhand der AKTUELLEN Kameraposition
    // an - während der 2s-Flugbewegung ändert sich die also laufend. Würde
    // waitForTilesReady() direkt nach dem Start von flyTo aufgerufen (wie
    // zuvor), kann die kurze Ruhephase zwischen "noch keine neuen Requests
    // für die bewegte Kamera" und "jetzt kommen die echten Requests fürs
    // Ziel" fälschlich als "fertig geladen" erkannt werden - man fliegt
    // dann doch wieder los, bevor die Zieltiles da sind.
    await new Promise((resolve) => {
      viewer.camera.flyTo({
        destination: startPosition,
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch: 0,
          roll: 0,
        },
        duration: 2,
        complete: resolve,
        cancel: resolve, // z.B. falls der Nutzer währenddessen erneut ESC drückt
      });
    });

    // Ein Orts-Sprung ist für die 3D Tiles im Prinzip ein zweiter Kaltstart:
    // an der neuen Position müssen erst Kacheln nachgeladen werden. Bisher
    // wurde nach einer festen Wartezeit fortgesetzt, unabhängig davon, ob
    // das schon fertig war - das führte zu ruckeligem Flug durch noch nicht
    // vollständig geladenes Terrain. Stattdessen wie beim initialen Laden
    // auf waitForTilesReady() warten und speed erst danach setzen.
    searchStatusEl.textContent = "Lade Kacheln für neue Position…";
    await waitForTilesReady(tileset);
    searchStatusEl.textContent = `Gefunden: ${data.formatted_address}`;

    speed = 125 / 3.6; // 125 km/h in m/s, damit man nach der Suche direkt weiterfliegt
    // Interne Steuerungs-Zustände zurücksetzen: sonst übernimmt der
    // Tick-Handler nach dem Pausieren wieder den ALTEN pitch/roll-Wert von
    // vor dem Sprung und kippt die Kamera Richtung Boden, sobald es
    // fortgesetzt wird - unabhängig davon, dass flyTo selbst schon
    // horizontal ausgerichtet ist.
    pitch = 0;
    pitchRaw = 0;
    roll = 0;
    rollRaw = 0;
    rollLevelBlend = 0;
    pitchRate = 0;
    rollRate = 0;
    yawRate = 0;
    if (isPaused) togglePause();
  } catch (err) {
    console.error(err);
    searchStatusEl.textContent = "Fehler bei der Suche.";
    searchPanel.classList.remove("searching"); // erneute Eingabe erlauben
  }
}

searchButton.addEventListener("click", () =>
  geocodeAndFlyTo(searchInput.value),
);
searchInput.addEventListener("keydown", (e) => {
  if (e.code === "Enter") geocodeAndFlyTo(searchInput.value);
});

// --- 3D-Spots (Alternative zur freien Suche, nur im Pausenmodus) -------
// Nutzt die von Google veröffentlichte Liste der Photorealistic-3D-Tiles-
// Coverage-Gebiete (google_earth_3d_locations_by_country.json). Ein Eintrag
// ist dabei KEIN einzelner Ort, sondern oft mehrere ohne Trennzeichen
// aneinandergereihte Städte desselben Coverage-Gebiets (z.B. "Weinheim
// Ravensburg Reutlingen Stuttgart") - deshalb wird bewusst nicht versucht,
// das automatisch in Einzelstädte zu zerlegen (zu fehleranfällig, z.B. bei
// "Rothenburg ob der Tauber"). Jeder String wird als ein Spot behandelt und
// beim Klick unverändert an geocodeAndFlyTo() übergeben.
const tabSearchBtn = document.getElementById("tab-search-btn");
const tabSpotsBtn = document.getElementById("tab-spots-btn");
const tabFavoritesBtn = document.getElementById("tab-favorites-btn");
const tabSearchPanel = document.getElementById("tab-search");
const tabSpotsPanel = document.getElementById("tab-spots");
const tabFavoritesPanel = document.getElementById("tab-favorites");
const spotCountrySelect = document.getElementById("spot-country-select");
const spotFilterInput = document.getElementById("spot-filter-input");
const spotListEl = document.getElementById("spot-list");
const spotStatusEl = document.getElementById("spot-status");

const SPOT_RESULT_LIMIT = 150;

// Flache Liste aller Spots einmalig aufbauen: {country, name} - vermeidet,
// bei jeder Eingabe erneut durch das verschachtelte Objekt zu iterieren.
const allSpots = Object.entries(spotsByCountry).flatMap(([country, names]) =>
  names.map((name) => ({ country, name })),
);

// Länder-Dropdown alphabetisch befüllen (Objektreihenfolge in der JSON ist
// nicht alphabetisch, z.B. Kontinente gruppiert).
Object.keys(spotsByCountry)
  .sort((a, b) => a.localeCompare(b, "de"))
  .forEach((country) => {
    const option = document.createElement("option");
    option.value = country;
    option.textContent = country;
    spotCountrySelect.appendChild(option);
  });

function switchSearchTab(tab, focusInput = true) {
  const showSpots = tab === "spots";
  const showFavorites = tab === "favorites";
  tabSearchBtn.classList.toggle("active", !showSpots && !showFavorites);
  tabSpotsBtn.classList.toggle("active", showSpots);
  tabFavoritesBtn.classList.toggle("active", showFavorites);
  tabSearchPanel.hidden = showSpots || showFavorites;
  tabSpotsPanel.hidden = !showSpots;
  tabFavoritesPanel.hidden = !showFavorites;
  if (showSpots) {
    renderSpotList();
  } else if (showFavorites) {
    renderFavoriteList();
  } else if (focusInput) {
    searchInput.focus();
  }
}

tabSearchBtn.addEventListener("click", () => switchSearchTab("search"));
tabSpotsBtn.addEventListener("click", () => switchSearchTab("spots"));
tabFavoritesBtn.addEventListener("click", () => switchSearchTab("favorites"));
searchPanelCloseBtn.addEventListener("click", () => {
  if (isPaused) togglePause();
});

function renderSpotList() {
  const country = spotCountrySelect.value;
  const filterText = spotFilterInput.value.trim().toLowerCase();

  spotListEl.innerHTML = "";

  if (!country && !filterText) {
    spotStatusEl.textContent = "Land wählen oder Suchbegriff eingeben.";
    return;
  }

  let matches = allSpots;
  if (country) matches = matches.filter((spot) => spot.country === country);
  if (filterText)
    matches = matches.filter((spot) =>
      spot.name.toLowerCase().includes(filterText),
    );

  if (matches.length === 0) {
    spotStatusEl.textContent = "Keine Treffer.";
    return;
  }

  matches = [...matches].sort((a, b) => a.name.localeCompare(b.name));

  const truncated = matches.length > SPOT_RESULT_LIMIT;
  const shown = truncated ? matches.slice(0, SPOT_RESULT_LIMIT) : matches;

  spotStatusEl.textContent = truncated
    ? `${matches.length} Treffer - bitte weiter eingrenzen (zeige ${SPOT_RESULT_LIMIT}).`
    : `${matches.length} Treffer.`;

  for (const spot of shown) {
    const li = document.createElement("li");
    li.className = "spot-item";
    li.textContent = spot.name;
    li.title = `${spot.name} (${spot.country})`;
    li.addEventListener("click", () => {
      // Einträge wie "Entire country" oder "Entire country except ..."
      // (z.B. Monaco, San Marino, Vatikanstadt, Malta) lassen sich nicht
      // geocodieren, da sie keinen echten Ortsnamen enthalten - stattdessen
      // den Ländernamen als Suchanfrage verwenden. Angezeigt wird trotzdem
      // weiterhin der Original-Spot-Name.
      const query = /^entire country/i.test(spot.name)
        ? spot.country
        : spot.name;
      searchInput.value = query;
      geocodeAndFlyTo(query);
    });
    spotListEl.appendChild(li);
  }
}

spotCountrySelect.addEventListener("change", renderSpotList);
spotFilterInput.addEventListener("input", renderSpotList);

// Nutzt dieselbe pickRandomSpotQuery() wie der zufällige Startort beim
// initialen Laden (siehe loadGoogleTiles oben) - ignoriert bewusst den
// aktuell gewählten Länder-/Filter-Eintrag und wählt aus der KOMPLETTEN
// Spot-Liste, nicht nur aus den gerade sichtbaren Treffern.
randomSpotButton.addEventListener("click", () => {
  const query = pickRandomSpotQuery();
  searchInput.value = query;
  geocodeAndFlyTo(query);
});

// --- Favoriten (gespeicherte Positionen, nur im Pausenmodus) -----------
// Speichert den kompletten pausierten Zustand (Ort, Position/Ausrichtung,
// Geschwindigkeit, FOV, Kamera-Tilt) unter einem selbstgewählten Namen in
// localStorage - anders als CAMERA_STATE_KEY oben (sessionStorage, nur
// fürs Dev-Comfort beim Reload) bleiben Favoriten dauerhaft erhalten, bis
// sie explizit gelöscht werden.
const FAVORITES_KEY = "flymaps_favorites";
const FAVORITE_SCHEMA_VERSION = 2;
const FAVORITES_API_URL = "/api/favorites";

const favoriteNameInput = document.getElementById("favorite-name-input");
const favoriteSaveButton = document.getElementById("favorite-save-button");
const favoriteListEl = document.getElementById("favorite-list");
const favoriteStatusEl = document.getElementById("favorite-status");

async function fetchFavoritesFromFile() {
  const response = await fetch(FAVORITES_API_URL, { cache: "no-store" });
  if (!response.ok)
    throw new Error(
      `Favoriten-Datei konnte nicht gelesen werden (${response.status})`,
    );
  const data = await response.json();
  return Array.isArray(data.favorites) ? data.favorites : [];
}

async function persistFavoritesToFile(favorites) {
  const response = await fetch(FAVORITES_API_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorites }),
  });
  if (!response.ok)
    throw new Error(
      `Favoriten-Datei konnte nicht gespeichert werden (${response.status})`,
    );
}

function loadFavoritesFromBrowser() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isUsableFavorite) : [];
  } catch {
    return [];
  }
}

async function loadFavorites() {
  try {
    const fileFavorites = (await fetchFavoritesFromFile()).filter(
      isUsableFavorite,
    );
    const browserFavorites = loadFavoritesFromBrowser();
    if (fileFavorites.length === 0 && browserFavorites.length > 0) {
      await persistFavoritesToFile(browserFavorites);
      return browserFavorites;
    }
    return fileFavorites;
  } catch {
    return loadFavoritesFromBrowser();
  }
}

function isUsableFavorite(favorite) {
  return (
    favorite &&
    typeof favorite.id === "string" &&
    typeof favorite.name === "string" &&
    [
      favorite.x,
      favorite.y,
      favorite.z,
      favorite.heading,
      favorite.pitch,
      favorite.roll,
      favorite.speed,
    ].every(Number.isFinite)
  );
}

function persistFavoritesToBrowser(favorites) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // localStorage kann z.B. im privaten Modus fehlschlagen - dann eben ohne Persistenz
  }
}

async function persistFavorites(favorites) {
  try {
    await persistFavoritesToFile(favorites);
    persistFavoritesToBrowser(favorites);
  } catch {
    persistFavoritesToBrowser(favorites);
  }
}

async function renderFavoriteList() {
  const favorites = await loadFavorites();
  favoriteListEl.innerHTML = "";

  if (favorites.length === 0) {
    favoriteStatusEl.textContent = "Noch keine Favoriten gespeichert.";
    return;
  }
  favoriteStatusEl.textContent = `${favorites.length} Favorit${favorites.length === 1 ? "" : "en"}.`;

  for (const favorite of favorites) {
    const li = document.createElement("li");
    li.className = "favorite-item";

    const info = document.createElement("div");
    info.className = "favorite-item-info";
    const nameEl = document.createElement("span");
    nameEl.className = "favorite-item-name";
    nameEl.textContent = favorite.name;
    const locationEl = document.createElement("span");
    locationEl.className = "favorite-item-location";
    const details = [`${Math.round(favorite.speed * 3.6)} km/h`];
    if (Number.isFinite(favorite.altitudeMeters))
      details.push(`${Math.round(favorite.altitudeMeters)} m`);
    locationEl.textContent = `${favorite.locationLabel ?? "Unbekannter Ort"} · ${details.join(" · ")}`;
    info.append(nameEl, locationEl);
    info.addEventListener("click", () => flyToFavorite(favorite));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "favorite-item-delete";
    deleteButton.textContent = "×";
    deleteButton.title = "Favorit löschen";
    deleteButton.setAttribute(
      "aria-label",
      `Favorit "${favorite.name}" löschen`,
    );
    deleteButton.addEventListener("click", (e) => {
      e.stopPropagation(); // sonst würde der Klick zusätzlich den Anflug auslösen
      deleteFavorite(favorite.id);
    });

    li.append(info, deleteButton);
    favoriteListEl.appendChild(li);
  }
}

async function deleteFavorite(id) {
  await persistFavorites(
    (await loadFavorites()).filter((favorite) => favorite.id !== id),
  );
  await renderFavoriteList();
}

async function saveFavorite() {
  const name = favoriteNameInput.value.trim();
  if (!name) {
    favoriteStatusEl.textContent = "Bitte einen Namen eingeben.";
    return;
  }

  // Ort wiederverwenden, der beim Pausieren bereits per Reverse-Geocoding
  // ermittelt wurde (updateCurrentLocation()) - kein zusätzlicher API-Call
  // nötig. Läuft die Anfrage noch, wird das stattdessen offen benannt.
  const locationLabel =
    currentLocationEl.textContent &&
    !currentLocationEl.textContent.endsWith("…")
      ? currentLocationEl.textContent
      : "Unbekannter Ort";

  const p = viewer.camera.position;
  const carto = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  const favorite = {
    version: FAVORITE_SCHEMA_VERSION,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    locationLabel,
    createdAt: new Date().toISOString(),
    x: p.x,
    y: p.y,
    z: p.z,
    longitude: Cesium.Math.toDegrees(carto.longitude),
    latitude: Cesium.Math.toDegrees(carto.latitude),
    altitudeMeters: carto.height,
    heading: viewer.camera.heading,
    pitch,
    roll,
    pitchRate,
    rollRate,
    yawRate,
    speed,
    fovDegrees: Cesium.Math.toDegrees(viewer.camera.frustum.fov),
    cameraTiltDegrees: Cesium.Math.toDegrees(cameraTiltOffset),
    minimapLabelsVisible,
    planeVisible,
    contrastPct: colorGradeSettings.contrastAmount * 100,
    saturationPct: colorGradeSettings.saturationAmount * 100,
    brightnessPct: colorGradeSettings.brightnessAmount * 100,
    sepiaPct: colorGradeSettings.sepiaAmount * 100,
    vignettePct: colorGradeSettings.vignetteAmount * 100,
    grainPct: (colorGradeSettings.grainAmount / GRAIN_MAX_INTENSITY) * 100,
    blurPct: colorGradeSettings.blurAmount * 100,
  };

  const favorites = await loadFavorites();
  favorites.push(favorite);
  await persistFavorites(favorites);

  favoriteNameInput.value = "";
  await renderFavoriteList();
}

favoriteSaveButton.addEventListener("click", saveFavorite);
favoriteNameInput.addEventListener("keydown", (e) => {
  if (e.code === "Enter") saveFavorite();
});

// Sanfter Anflug (2s flyTo) wie bei der Ortssuche - der Unterschied ist
// nur, dass hier bereits eine exakte Kameraposition/-lage vorliegt, also
// keine Geocoding-Anfrage und keine Anflug-Positionsberechnung nötig sind.
async function flyToFavorite(favorite) {
  searchStatusEl.textContent = `Fliege zu "${favorite.name}"…`;
  searchPanel.classList.add("searching");
  try {
    const destination = new Cesium.Cartesian3(
      favorite.x,
      favorite.y,
      favorite.z,
    );

    await new Promise((resolve) => {
      viewer.camera.flyTo({
        destination,
        orientation: {
          heading: favorite.heading,
          pitch: favorite.pitch,
          roll: favorite.roll,
        },
        duration: 2,
        complete: resolve,
        cancel: resolve, // z.B. falls währenddessen erneut ESC gedrückt wird
      });
    });

    searchStatusEl.textContent = "Lade Kacheln für neue Position…";
    await waitForTilesReady(tileset);
    searchStatusEl.textContent = `Angekommen: ${favorite.name}`;

    speed = favorite.speed;
    // Interne Steuerungs-Zustände zurücksetzen - sonst übernimmt der
    // Tick-Handler nach dem Fortsetzen wieder den ALTEN pitch/roll-Wert
    // von vor dem Sprung (siehe gleiches Vorgehen in geocodeAndFlyTo).
    pitch = favorite.pitch;
    pitchRaw = favorite.pitch;
    roll = favorite.roll;
    rollRaw = favorite.roll;
    rollLevelBlend = 0;
    pitchRate = Number.isFinite(favorite.pitchRate) ? favorite.pitchRate : 0;
    rollRate = Number.isFinite(favorite.rollRate) ? favorite.rollRate : 0;
    yawRate = Number.isFinite(favorite.yawRate) ? favorite.yawRate : 0;
    if (Number.isFinite(favorite.fovDegrees)) applyFov(favorite.fovDegrees);
    if (Number.isFinite(favorite.cameraTiltDegrees))
      applyCameraTilt(favorite.cameraTiltDegrees);
    if (typeof favorite.minimapLabelsVisible === "boolean")
      applyMinimapLabelsVisible(favorite.minimapLabelsVisible);
    if (typeof favorite.planeVisible === "boolean")
      applyPlaneVisible(favorite.planeVisible);
    if (Number.isFinite(favorite.contrastPct))
      applyContrast(favorite.contrastPct);
    if (Number.isFinite(favorite.saturationPct))
      applySaturation(favorite.saturationPct);
    if (Number.isFinite(favorite.brightnessPct))
      applyBrightness(favorite.brightnessPct);
    if (Number.isFinite(favorite.sepiaPct)) applySepia(favorite.sepiaPct);
    if (Number.isFinite(favorite.vignettePct))
      applyVignette(favorite.vignettePct);
    if (Number.isFinite(favorite.grainPct)) applyGrain(favorite.grainPct);
    if (Number.isFinite(favorite.blurPct)) applyBlur(favorite.blurPct);
    saveCameraState();

    if (isPaused) togglePause();
  } catch (err) {
    console.error(err);
    searchStatusEl.textContent = "Fehler beim Anfliegen des Favoriten.";
    searchPanel.classList.remove("searching");
  }
}

// --- Aktueller Ort (Reverse Geocoding, nur im Pausenmodus) --------------
// Nutzt denselben /api/geocode-Proxy wie die Ortssuche, hier mit dem
// latlng-Parameter statt q (siehe functions/api/geocode.js).
const currentLocationEl = document.getElementById("current-location");
const currentLocationMapsLinkEl = document.getElementById(
  "current-location-maps-link",
);
let currentLocationRequestId = 0;

async function updateCurrentLocation() {
  const carto = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);

  // Koordinaten liegen sofort vor (unabhängig vom Reverse-Geocoding-Ergebnis
  // weiter unten) - Google-Maps-Link kann daher direkt gesetzt werden.
  // Zoom-Level 6 zeigt neben dem eigenen Standort auch angrenzende Länder;
  // niedriger = weiter rausgezoomt.
  const mapsZoomLevel = 6;
  currentLocationMapsLinkEl.href = `https://www.google.com/maps?q=${lat},${lon}&z=${mapsZoomLevel}`;
  currentLocationMapsLinkEl.hidden = false;

  // Falls währenddessen erneut pausiert/fortgesetzt wird, soll nur die
  // jeweils letzte Anfrage das Ergebnis noch anzeigen dürfen.
  const requestId = ++currentLocationRequestId;
  currentLocationEl.textContent = "Aktueller Ort wird ermittelt…";

  try {
    const url = `/api/geocode?latlng=${lat},${lon}`;
    const response = await fetch(url);
    const data = await response.json();
    if (requestId !== currentLocationRequestId) return; // veraltete Antwort

    if (data.status === "OK") {
      currentLocationEl.textContent = data.formatted_address;
    } else {
      currentLocationEl.textContent = "Ort konnte nicht ermittelt werden.";
    }
  } catch (err) {
    if (requestId !== currentLocationRequestId) return;
    console.error(err);
    currentLocationEl.textContent = "Ort konnte nicht ermittelt werden.";
  }
}

// --- Pause (ESC) -------------------------------------------------------
// Der HUD-Status wird über setStatus() gesetzt, damit "Pausiert" den
// eigentlichen Lade-/Fehlertext nicht überschreibt, sondern beim
// Fortsetzen wiederhergestellt wird.
function togglePause() {
  isPaused = !isPaused;
  pressedKeys.clear();
  randomSpotButton.hidden = !isPaused;
  document.body.classList.toggle("pause-mode", isPaused);

  if (isPaused) {
    viewer.camera.cancelFlight();
    statusEl.textContent = "Pausiert (Leertaste zum Fortsetzen)";
    hudEl.style.display = "";
    searchPanel.classList.add("visible");
    searchPanel.classList.remove("searching");
    updateCurrentLocation();
    searchStatusEl.textContent = "";
    searchInput.value = "";
    switchSearchTab("search", false);
    searchPanelCloseBtn.focus();
  } else {
    statusEl.textContent = baseStatusText;
    hudEl.style.display = isStatusVisible ? "" : "none";
    searchPanel.classList.remove("visible");
    searchInput.blur();
    currentLocationRequestId++; // laufende Reverse-Geocoding-Anfrage verwerfen
  }
}

// Leertaste löst normalerweise Pause/Fortsetzen aus - aber nicht, wenn
// gerade in einem Eingabefeld getippt wird (z.B. Ortssuche, Favoriten-
// Name, Spot-Filter): sonst würde ein Leerzeichen im Text versehentlich
// das Pausenmenü schließen/öffnen, statt einfach im Feld zu landen.
function isTypingInFormField(target) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  );
}

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat) return;
  if (isTypingInFormField(e.target)) return;
  e.preventDefault();
  if (controlsPanel.classList.contains("visible")) {
    closeControlsHelp();
    return;
  }
  togglePause();
});

// --- Cursor nach 3s Inaktivität ausblenden -------------------------------
let cursorHideTimeout;
function resetCursorTimer() {
  document.body.classList.remove("cursor-hidden");
  clearTimeout(cursorHideTimeout);
  cursorHideTimeout = setTimeout(() => {
    document.body.classList.add("cursor-hidden");
  }, 3000);
}
window.addEventListener("mousemove", resetCursorTimer);
resetCursorTimer();

// --- Drohnen-Flugsteuerung ---------------------------------------------
// W/S        = Schub (Geschwindigkeit hoch/runter)
// Pfeil hoch/runter = Nase hoch/runter (Pitch)
// Pfeil links/rechts = Rollen (Roll), erzeugt zusätzlich eine
//              koordinierte Kurve (wie bei einem Flugzeug: Rollen -> Gieren)
// A/D        = Seitenruder (Yaw), unabhängig vom Rollen
//
// Cesiums eingebaute Maussteuerung wird deaktiviert, weil wir die Kamera
// jetzt vollständig selbst über heading/pitch/roll + Vorwärtsbewegung
// steuern.
//
// WICHTIG: enableInputs=false reicht laut Cesium-Doku NICHT dauerhaft aus -
// es ist nur für temporäre Fälle (z.B. während eines camera.flyTo) gedacht
// und wird von Cesium intern nach Abschluss eines Kameraflugs automatisch
// wieder auf true gesetzt. Da geocodeAndFlyTo() flyTo nutzt, war die Maus
// nach der ersten Ortssuche wieder aktiv. Stattdessen die Einzel-Flags
// dauerhaft setzen:
const cameraController = viewer.scene.screenSpaceCameraController;
cameraController.enableTranslate = false;
cameraController.enableZoom = false;
cameraController.enableRotate = false;
cameraController.enableTilt = false;
cameraController.enableLook = false;

const MAX_SPEED = 120; // m/s, entspricht ca. 430 km/h
const THROTTLE_ACCEL = 40; // m/s^2 beim Gasgeben/Bremsen

const PITCH_RATE = Cesium.Math.toRadians(50); // rad/s, maximale Pitch-Änderungsrate
const PITCH_MAX = Cesium.Math.toRadians(45);
const PITCH_SMOOTH_TIME = 2.5; // Sekunden, bis die volle Rate erreicht ist (Einschwingen, bei gehaltener Taste)
const PITCH_RETURN_SMOOTH_TIME = 2; // Sekunden - schnelleres Ausschwingen/Reversieren der Rate beim Loslassen ODER Gegenlenken, damit man zügiger aus Pitch rauskommt (siehe pitchReturning)
const PITCH_LIMIT_EASE_DEG = 15; // Breite der Sättigungszone vor PITCH_MAX (siehe softLimitAngle)

const ROLL_RATE = Cesium.Math.toRadians(70);
const ROLL_MAX = Cesium.Math.toRadians(30);
const ROLL_SMOOTH_TIME = 2.5; // Sekunden, bis die volle Rate erreicht ist (Einschwingen, bei gehaltener Taste)
const ROLL_RETURN_SMOOTH_TIME = 1.25; // Sekunden - schnelleres Ausschwingen der Rate nach Loslassen, damit man zügiger aus der Schräglage rauskommt
const ROLL_AUTO_LEVEL_TIME = 1.5; // Sekunden - sehr langsamer, sanfter Drift zurück zu 0°, wenn keine Taste gedrückt ist
const ROLL_LEVEL_BLEND_TIME = 0.2; // Sekunden - Einblendzeit für den Auto-Level-Zug (verhindert einen harten Sprung in der Geschwindigkeit genau beim Einsetzen)
const ROLL_LIMIT_EASE_DEG = 15; // Breite der Sättigungszone vor ROLL_MAX (siehe softLimitAngle unten)

const RUDDER_YAW_RATE = Cesium.Math.toRadians(35); // A/D, maximale Yaw-Rate
const YAW_SMOOTH_TIME = 2; // Sekunden, bis die volle Rate erreicht ist
const ROLL_TURN_COEFF = 1.1; // wie stark Rollen zusätzlich Gieren erzeugt

// Sanfte Sättigungskurve statt hartem Clamp: innerhalb von
// (max - softZoneRad) verhält sich der Wert normal/linear, danach nähert
// er sich max exponentiell an, ohne ihn je zu überschreiten. Wird pro
// Frame frisch aus einem ungekappten Rohwert (rollRaw/pitchRaw) berechnet,
// statt iterativ auf dem bereits gesättigten Wert aufzubauen - sonst würde
// der komprimierte Wertebereich fälschlich als "linearer" Eingang für den
// nächsten Frame missverstanden, was zu einem spürbaren Zucken/
// Zurückspringen kurz vor der Grenze führte.
function softLimitAngle(rawValue, max, softZoneRad) {
  const linear = max - softZoneRad;
  const abs = Math.abs(rawValue);
  if (abs <= linear) return rawValue;
  const excess = abs - linear;
  return (
    Math.sign(rawValue) *
    (linear + softZoneRad * (1 - Math.exp(-excess / softZoneRad)))
  );
}

// Kehrfunktion zu softLimitAngle: liefert zu einem bereits komprimierten
// (angezeigten) Winkel den passenden unkomprimierten Rohwert zurück. Wird
// gebraucht, um rollRaw/pitchRaw nach einer ungebremsten "Schrumpf"-Bewegung
// (siehe unten) wieder korrekt zu synchronisieren, damit ein danach erneut
// einsetzendes Weiter-Wachsen wieder an der richtigen Stelle zu komprimieren
// beginnt statt einen Sprung zu verursachen.
function inverseSoftLimitAngle(value, max, softZoneRad) {
  const linear = max - softZoneRad;
  const abs = Math.abs(value);
  if (abs <= linear) return value;
  // abs nähert sich asymptotisch (linear + softZoneRad) an, nie ganz - der
  // Clamp knapp darunter verhindert eine Singularität im log() bei Werten,
  // die praktisch am Limit kleben.
  const excessDisplay = Math.min(abs - linear, softZoneRad * 0.999999);
  const excessRaw = -softZoneRad * Math.log(1 - excessDisplay / softZoneRad);
  return Math.sign(value) * (linear + excessRaw);
}

// --- Kollision mit Gebäuden/Terrain (3D Tiles) --------------------------
// Statt einer Höhen-Abfrage (wie bei getGroundHeight) wird hier pro Frame
// ein echter Strahl entlang der Flugrichtung gegen die geladene 3D-Tiles-
// Geometrie geschossen (pickFromRay - testet die tatsächliche Mesh-Geometrie,
// nicht nur den Tiefenpuffer, funktioniert also auch für Punkte, die gerade
// nicht im Bild sind). Reichweite = die Strecke, die in diesem Frame ohnehin
// zurückgelegt würde, plus Sicherheitsabstand - damit weder unnötig oft
// (Performance) noch zu spät (Tunneling durch dünne Geometrie) geprüft wird.
const COLLISION_SAFETY_MARGIN = 4; // Meter Abstand, der zum Hindernis stehen bleibt
const COLLISION_LOOKAHEAD_MIN = 8; // Meter Mindest-Prüfreichweite (auch bei niedriger Geschwindigkeit)
const COLLISION_BRAKE_DECEL = 200; // m/s^2 - deutlich stärker als THROTTLE_ACCEL, aber kein harter Ruck

function checkCollisionAhead(origin, direction, maxDistance) {
  if (maxDistance <= 0) return null;
  const ray = new Cesium.Ray(origin, direction);
  const result = viewer.scene.pickFromRay(ray, []);
  if (!result || !result.position) return null;
  const distance = Cesium.Cartesian3.distance(origin, result.position);
  if (distance > maxDistance) return null;
  return distance;
}

const collisionFlashEl = document.getElementById("collision-flash");
function triggerCollisionFlash() {
  // Animation neu starten, auch wenn kurz hintereinander mehrfach kollidiert
  // wird (z.B. wenn man weiter gegen die Wand steuert): Klasse entfernen,
  // Reflow erzwingen, wieder hinzufügen.
  collisionFlashEl.classList.remove("flash");
  void collisionFlashEl.offsetWidth;
  collisionFlashEl.classList.add("flash");
}

let speed = 0;
let pitch = 0; // angezeigter/tatsächlich geflogener Wert, immer = softLimitAngle(pitchRaw, ...)
let pitchRaw = 0; // ungekappter interner Akkumulator, siehe softLimitAngle oben
let roll = 0; // angezeigter/tatsächlich geflogener Wert, immer = softLimitAngle(rollRaw, ...)
let rollRaw = 0; // ungekappter interner Akkumulator, siehe softLimitAngle oben
let rollLevelBlend = 0; // 0..1, sanftes Ein-/Ausblenden des Auto-Level-Zugs (siehe ROLL_LEVEL_BLEND_TIME)
let pitchRate = 0; // aktuelle (geglättete) Pitch-Änderungsrate
let rollRate = 0; // aktuelle (geglättete) Roll-Änderungsrate
let yawRate = 0; // aktuelle (geglättete) Seitenruder-Rate
let wasColliding = false; // für Flankenerkennung: Flash nur beim Kollisionsbeginn auslösen

const pressedKeys = new Set();
window.addEventListener("keydown", (e) => {
  if (!isPaused) pressedKeys.add(e.code);
});
window.addEventListener("keyup", (e) => pressedKeys.delete(e.code));
window.addEventListener("blur", () => pressedKeys.clear());

let lastTime = performance.now();
let lastSaveTime = 0;
const SAVE_INTERVAL_MS = 500; // wie oft die Position für den Reload-Fall gesichert wird

// Beim schnellen Wechsel zwischen zwei entgegengesetzten Pfeiltasten (z.B.
// Rechts -> Links für Roll) lässt man die eine Taste in der Praxis kurz los,
// bevor die andere gedrückt wird. In dieser Lücke sind beide Tasten
// losgelassen, das Ziel würde kurz auf 0 fallen und die Rate Richtung 0
// abgebaut - spürbar als kurzes Innehalten, bevor die neue Richtung
// eigentlich schon "gemeint" war. KEY_SWITCH_GRACE_MS toleriert solche
// kurzen Lücken: die zuletzt gedrückte Richtung bleibt als Ziel aktiv, bis
// entweder die Gegenrichtung gedrückt wird oder die Toleranzzeit abläuft
// (dann erst gilt es als echtes Loslassen).
const KEY_SWITCH_GRACE_MS = 120;

function createAxisTargetTracker(negativeKeyCode, positiveKeyCode, rate) {
  let gapStartTime = null;
  let lastDirection = 0; // -1, 0 oder 1 - zuletzt tatsächlich gedrückte Richtung
  return function getTarget(now) {
    const negativeHeld = pressedKeys.has(negativeKeyCode);
    const positiveHeld = pressedKeys.has(positiveKeyCode);
    if (negativeHeld || positiveHeld) {
      gapStartTime = null;
      lastDirection = negativeHeld ? -1 : 1;
      return lastDirection * rate;
    }
    if (gapStartTime === null) gapStartTime = now;
    if (now - gapStartTime < KEY_SWITCH_GRACE_MS && lastDirection !== 0) {
      return lastDirection * rate; // innerhalb der Toleranzzeit: altes Ziel beibehalten
    }
    lastDirection = 0;
    return 0; // Toleranzzeit abgelaufen: jetzt wirklich losgelassen
  };
}

// Pitch-Mapping TESTWEISE INVERTIERT (ArrowUp = -RATE), siehe Kommentar
// beim ursprünglichen pitchTarget weiter unten.
const getPitchTarget = createAxisTargetTracker(
  "ArrowUp",
  "ArrowDown",
  PITCH_RATE,
);
const getRollTarget = createAxisTargetTracker(
  "ArrowLeft",
  "ArrowRight",
  ROLL_RATE,
);

viewer.clock.onTick.addEventListener(() => {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.1); // Cap gegen Tab-Wechsel-Sprünge
  lastTime = now;

  // Pausiert: keine Bewegung/Steuerungsänderung, Frame einfach überspringen
  // (lastTime wurde oben schon aktualisiert, damit es beim Fortsetzen keinen dt-Sprung gibt)
  if (isPaused) return;

  const camera = viewer.camera;

  // Schub: W erhöht, S verringert die Geschwindigkeit - ohne Tastendruck
  // bleibt der aktuelle Wert einfach erhalten (kein Abbremsen von selbst).
  if (pressedKeys.has("KeyW")) {
    speed = Math.min(speed + THROTTLE_ACCEL * dt, MAX_SPEED);
  } else if (pressedKeys.has("KeyS")) {
    speed = Math.max(speed - THROTTLE_ACCEL * dt, -MAX_SPEED * 0.3);
  }

  // Pitch: TESTWEISE INVERTIERT - Pfeil hoch = Nase runter, Pfeil runter =
  // Nase hoch. Die Rate wird weiterhin sanft an-/abgebremst, der Winkel
  // bleibt stehen, wenn keine Taste gedrückt ist. getPitchTarget toleriert
  // kurze Tasten-Lücken beim Richtungswechsel (siehe createAxisTargetTracker
  // oben).
  const pitchTarget = getPitchTarget(now);
  // Die schnellere PITCH_RETURN_SMOOTH_TIME gilt beim echten Loslassen
  // (pitchTarget === 0) UND beim aktiven Gegenlenken (Ziel entgegengesetzt
  // zum aktuellen Winkel, pitchOpposesAngle) - sonst hängt die Ratenrampe
  // bei 100% Pitch bis zu PITCH_SMOOTH_TIME lang fest, bevor die Rate
  // überhaupt durch 0 durchquert und sich am Winkel etwas zu ändern beginnt.
  // Wichtig: Vergleich gegen den WINKEL (pitch), nicht gegen die Rate -
  // sonst würde die Rate beim Reversieren schon nach kurzer Zeit die 0
  // kreuzen und fälschlich zu früh auf die langsame Zeit zurückschalten,
  // während der Flieger real noch in der alten Neigung hängt (siehe
  // identisches Problem/Fix beim Roll weiter unten).
  const pitchOpposesAngle =
    pitch !== 0 && Math.sign(pitchTarget) !== Math.sign(pitch);
  const pitchReturning = pitchTarget === 0 || pitchOpposesAngle;
  // Lineare Rampe (konstante Winkelbeschleunigung) statt e-Funktions-
  // Glättung: ändert pitchRate immer mit exakt derselben Beschleunigung,
  // egal wie groß die aktuelle Neigung oder das verbleibende Delta ist -
  // dadurch wirkt jede Kehrtwende/jeder Aufbau gleich smooth (gleiches
  // Prinzip wie bei rollRate weiter unten).
  const pitchAccel =
    PITCH_RATE / (pitchReturning ? PITCH_RETURN_SMOOTH_TIME : PITCH_SMOOTH_TIME);
  const pitchRateStep = Cesium.Math.clamp(
    pitchTarget - pitchRate,
    -pitchAccel * dt,
    pitchAccel * dt,
  );
  pitchRate += pitchRateStep;

  // Gleiches Prinzip wie beim Roll weiter unten: die Sättigungsbremse
  // (softLimitAngle) soll nur beim Wachsen (Richtung Limit) greifen, nicht
  // beim Schrumpfen (Richtung Mitte/Gegenlenken).
  const pitchSoftZoneRad = Cesium.Math.toRadians(PITCH_LIMIT_EASE_DEG);
  const pitchDelta = pitchRate * dt;
  const pitchGrowing =
    pitch !== 0 && Math.sign(pitchDelta) === Math.sign(pitch);

  if (pitchGrowing) {
    pitchRaw += pitchDelta;
    // Gleicher Grund wie beim rollRaw-Auslauf weiter unten.
    pitchRaw = Cesium.Math.clamp(
      pitchRaw,
      -(PITCH_MAX + pitchSoftZoneRad * 3),
      PITCH_MAX + pitchSoftZoneRad * 3,
    );
    pitch = softLimitAngle(pitchRaw, PITCH_MAX, pitchSoftZoneRad);
  } else {
    pitch = Cesium.Math.clamp(pitch + pitchDelta, -PITCH_MAX, PITCH_MAX);
    pitchRaw = inverseSoftLimitAngle(pitch, PITCH_MAX, pitchSoftZoneRad);
  }


  // Roll: Pfeil links/rechts - Ansprechverhalten genau wie Pitch/Yaw (Taps
  // addieren sich smooth auf, kein sofortiges Zurückschnappen). Die kurze
  // ROLL_RETURN_SMOOTH_TIME gilt nicht nur beim Loslassen, sondern auch bei
  // einem Richtungswechsel bei gehaltener Taste (Ziel hat entgegengesetztes
  // Vorzeichen zur aktuellen Rate) - sonst würde rollRate beim Reversieren
  // erst langsam über ROLL_SMOOTH_TIME abgebaut, während rollRaw in der
  // Zeit spürbar noch in die alte Richtung weiterläuft (kleiner Ruckler).
  // Zusätzlich driftet der Winkel ohne Tastendruck sehr langsam zu 0°
  // zurück (ROLL_AUTO_LEVEL_TIME), damit man nicht dauerhaft in Schräglage
  // hängt, ohne dass es sich beim aktiven Steuern spürbar "gegen die Hand"
  // anfühlt.
  const rollHeld =
    pressedKeys.has("ArrowLeft") || pressedKeys.has("ArrowRight");
  const rollTarget = getRollTarget(now);
  // Die schnellere ROLL_RETURN_SMOOTH_TIME gilt bewusst NUR noch beim
  // echten Loslassen (kein Pfeil mehr gedrückt, rollTarget === 0) - nicht
  // mehr bei einem Richtungswechsel bei weiterhin gehaltener Taste. Sonst
  // fühlt sich ein direkter Wechsel (z.B. von voller Linkslage sofort auf
  // Rechts) spürbar hektischer/schneller an als ein Aufbau aus dem
  // Geradeausflug, weil dafür die schnelle statt der normalen Zeitkonstante
  // greift. Ein gehaltener Richtungswechsel läuft jetzt genau mit derselben
  // Beschleunigung wie jeder andere Aufbau - dadurch immer gleich ruhig,
  // unabhängig vom Ausgangswinkel.
  const rollReturning = rollTarget === 0;
  // Lineare Rampe (konstante Winkelbeschleunigung) statt e-Funktions-
  // Glättung: ändert rollRate immer mit exakt derselben Beschleunigung,
  // egal wie groß die aktuelle Schräglage oder das verbleibende Delta ist.
  const rollAccel =
    ROLL_RATE / (rollReturning ? ROLL_RETURN_SMOOTH_TIME : ROLL_SMOOTH_TIME);
  const rollRateStep = Cesium.Math.clamp(
    rollTarget - rollRate,
    -rollAccel * dt,
    rollAccel * dt,
  );
  rollRate += rollRateStep;

  // Die Sättigungsbremse (softLimitAngle) soll nur greifen, wenn der Winkel
  // WÄCHST (Richtung Limit), nicht wenn er SCHRUMPFT (Richtung Mitte) - sonst
  // bremst dieselbe Kompression auch das Gegenlenken künstlich aus, obwohl
  // sie nur das harte Ankommen am Limit abfedern soll. Deshalb zwei Zweige:
  // wachsend weiter über rollRaw + softLimitAngle (komprimiert), schrumpfend
  // direkt auf roll (1:1, ungebremst) - rollRaw wird danach über die
  // Kehrfunktion nachgeführt, damit ein erneutes Weiter-Wachsen wieder an der
  // richtigen Stelle zu komprimieren beginnt statt zu springen.
  const rollSoftZoneRad = Cesium.Math.toRadians(ROLL_LIMIT_EASE_DEG);
  const rollDelta = rollRate * dt;
  const rollGrowing = roll !== 0 && Math.sign(rollDelta) === Math.sign(roll);

  if (rollGrowing) {
    rollRaw += rollDelta;
    // Auslauf für rollRaw über ROLL_MAX hinaus: schadet dem Gegenlenken
    // nicht mehr (das läuft über den Schrumpf-Zweig direkt auf roll, siehe
    // unten), erlaubt der Kompressionskurve aber, tief genug in ihre
    // Sättigung reinzulaufen, damit sie sich spürbar näher an ROLL_MAX
    // heranarbeitet, statt abrupt an einem zu engen Clamp anzuschlagen.
    rollRaw = Cesium.Math.clamp(
      rollRaw,
      -(ROLL_MAX + rollSoftZoneRad * 3),
      ROLL_MAX + rollSoftZoneRad * 3,
    );
    roll = softLimitAngle(rollRaw, ROLL_MAX, rollSoftZoneRad);
  } else {
    roll = Cesium.Math.clamp(roll + rollDelta, -ROLL_MAX, ROLL_MAX);
    rollRaw = inverseSoftLimitAngle(roll, ROLL_MAX, rollSoftZoneRad);
  }

  // Der Auto-Level-Zug Richtung 0° soll nicht nur beim kompletten Loslassen
  // greifen, sondern auch, solange man aktiv GEGENlenkt (Ziel entgegengesetzt
  // zum aktuellen Winkel) - sonst hängt man beim Gegenlenken einseitig nur
  // an der langsamen Rate-Rampe, die erst durch 0 durchqueren muss, während
  // Loslassen zusätzlich diesen direkten Zug bekommt und dadurch spürbar
  // schneller wieder gerade auf Kurs kommt als aktives Gegensteuern. Der Zug
  // ist ebenfalls eine "schrumpfende" Bewegung Richtung Mitte und läuft
  // deshalb direkt auf roll, ungebremst durch die Sättigungszone. Sobald der
  // Winkel auf die neue (Ziel-)Seite gewechselt hat, baut man aktiv in die
  // neue Richtung auf - dann greift der Zug nicht mehr, damit er der
  // Eingabe nicht entgegenwirkt.
  const rollOpposesTarget =
    roll !== 0 && Math.sign(rollTarget) !== Math.sign(roll);
  const rollLevelShouldBeActive = !rollHeld || rollOpposesTarget;
  // Statt eines harten Ja/Nein-Schalters wird die Zugstärke über
  // ROLL_LEVEL_BLEND_TIME sanft ein-/ausgeblendet - sonst springt die
  // sichtbare Geschwindigkeit genau beim Einsetzen (z.B. direkt nach dem
  // Loslassen bei voller Schräglage, wo roll durch die Sättigung zuvor
  // fast eingefroren war) von "quasi still" auf "voller Zug", was sich wie
  // ein kleiner Sprung anfühlt. Das Ein-/Ausblenden selbst ändert nichts
  // an Timing oder Tempo der eigentlichen Rückkehr (ROLL_AUTO_LEVEL_TIME),
  // nur an diesem einen Übergangsmoment.
  rollLevelBlend = Cesium.Math.clamp(
    rollLevelBlend +
      (rollLevelShouldBeActive ? 1 : -1) * (dt / ROLL_LEVEL_BLEND_TIME),
    0,
    1,
  );
  if (rollLevelBlend > 0) {
    const levelFactor =
      (1 - Math.exp(-dt / ROLL_AUTO_LEVEL_TIME)) * rollLevelBlend;
    roll -= roll * levelFactor;
    rollRaw = inverseSoftLimitAngle(roll, ROLL_MAX, rollSoftZoneRad);
  }


  // Gieren (Heading): Seitenruder A/D (sanft geglättet wie Pitch) +
  // koordinierte Kurve durch Rollen (bleibt direkt an den Roll-Winkel gekoppelt).
  const yawTarget = pressedKeys.has("KeyA")
    ? -RUDDER_YAW_RATE
    : pressedKeys.has("KeyD")
      ? RUDDER_YAW_RATE
      : 0;
  const yawSmoothing = 1 - Math.exp(-dt / YAW_SMOOTH_TIME);
  yawRate += (yawTarget - yawRate) * yawSmoothing;

  let heading = camera.heading;
  heading += yawRate * dt;
  heading += roll * ROLL_TURN_COEFF * dt;

  camera.setView({
    destination: camera.position,
    orientation: { heading, pitch, roll },
  });

  // Kollisionsprüfung: nur bei Vorwärtsflug, Reichweite = das, was ohnehin
  // in diesem Frame zurückgelegt würde, plus Sicherheitsabstand (siehe
  // Kommentar oben bei den Konstanten).
  if (speed > 0) {
    const lookahead = Math.max(
      speed * dt + COLLISION_SAFETY_MARGIN,
      COLLISION_LOOKAHEAD_MIN,
    );
    const hitDistance = checkCollisionAhead(
      camera.positionWC,
      camera.direction,
      lookahead,
    );

    if (hitDistance !== null) {
      if (!wasColliding) {
        triggerCollisionFlash();
        wasColliding = true;
      }
      // Abgleiten statt Vollstopp: je näher das Hindernis (innerhalb des
      // Sicherheitsabstands), desto stärker die Bremsverzögerung. Liegt
      // die freie Strecke noch über dem Sicherheitsabstand, wird noch gar
      // nicht gebremst - erst der Puffer selbst wird "weich" abgefangen.
      const penetration = Math.max(COLLISION_SAFETY_MARGIN - hitDistance, 0);
      if (penetration > 0) {
        const brake =
          COLLISION_BRAKE_DECEL * (penetration / COLLISION_SAFETY_MARGIN);
        speed = Math.max(speed - brake * dt, 0);
      }
    } else {
      wasColliding = false;
    }
  } else {
    wasColliding = false;
  }

  if (speed !== 0) {
    camera.moveForward(speed * dt);
  }

  // Kamera-Blickwinkel (FPV-Drohnen-Gimbal): erst NACHDEM sich die Position
  // entlang des normalen Flugpfads (unveränderter pitch/roll/heading)
  // bewegt hat, wird der zusätzliche Blickwinkel-Offset rein fürs Rendering
  // auf die tatsächliche Kamera-Ausrichtung addiert. Die Flugsteuerung
  // selbst (Bewegungsrichtung, pitch/roll-Variablen) bleibt unangetastet.
  if (cameraTiltOffset !== 0) {
    camera.setView({
      destination: camera.position,
      orientation: {
        heading,
        pitch: clampedRenderPitch(cameraTiltOffset),
        roll,
      },
    });
  }

  // Geschwindigkeitsanzeige (HUD): m/s -> km/h
  speedEl.textContent = `${Math.round(speed * 3.6)} km/h`;

  // Höhenanzeige (HUD): Höhe über dem WGS84-Ellipsoid, nicht exakt über
  // Grund/Meeresspiegel, für einen Flugsimulator aber ausreichend genau.
  const altitude = Cesium.Cartographic.fromCartesian(camera.positionWC).height;
  altitudeEl.textContent = `${Math.round(altitude)} m`;

  updateMinimap();
  updateHorizon();
  updatePlaneModelMatrix();

  // Position/Lage regelmäßig für den Reload-Fall sichern (siehe oben)
  if (now - lastSaveTime > SAVE_INTERVAL_MS) {
    saveCameraState();
    lastSaveTime = now;
  }
});
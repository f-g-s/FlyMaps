import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import spotsByCountry from "./google_earth_3d_locations_by_country.json";
import { initDiscovery } from "./discover.js";
import { getApiKey, requestApiKey } from "./apikey.js";
import { geocode } from "./geocode.js";
import { setSoundsEnabled, setSoundsVolume, updateFlightAudio } from "./audio.js";

// --- API-Key -----------------------------------------------------------------
// Jeder Spieler nutzt seinen eigenen Google-API-Key (Eingabe-Dialog beim
// ersten Start, siehe apikey.js und startApp() unten). Es gibt keinen Standard-
// Key im Bundle.

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
const soundsToggle = document.getElementById("sounds-toggle");
soundsToggle.addEventListener("change", () => {
  setSoundsEnabled(soundsToggle.checked);
});
const soundsVolumeSlider = document.getElementById("sounds-volume-slider");
const soundsVolumeValue = document.getElementById("sounds-volume-value");
soundsVolumeSlider.addEventListener("input", () => {
  setSoundsVolume(Number(soundsVolumeSlider.value) / 100);
  soundsVolumeValue.textContent = `${soundsVolumeSlider.value}%`;
});
let isStatusVisible = true;
let isPaused = false;
// Ruhe-Pause (Taste P): Flug ist eingefroren, aber ohne Pausenmenü - zum
// ungestörten Anschauen der Landschaft. Unabhängig von isPaused (Menü).
let isViewPaused = false;
let baseStatusText = "Lade Weltdaten…";
let minimapWidget;
// Wird schon hier (statt erst weiter unten bei den Gamepad-Event-Listenern)
// deklariert, weil applyPlaneVisible() (siehe Drohnen-/Flugzeug-Abschnitt)
// und dessen initialer Aufruf schon vor der eigentlichen Gamepad-Sektion
// laufen und darauf zugreifen müssen (sonst "Cannot access before
// initialization" durch die let-Hoisting-Regeln).
let connectedGamepadIndex = null;

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
  // Cesiums eigener Fullscreen-Button passt optisch nicht zum Darkmode-
  // Design (helles Icon-Sprite, eckiger Rahmen) - wird deaktiviert und durch
  // #fullscreen-toggle-button (eigenes Markup/Styling, siehe unten) ersetzt.
  fullscreenButton: false,
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
        locationBannerEnabled,
        contrastPct: colorGradeSettings.contrastAmount * 100,
        saturationPct: colorGradeSettings.saturationAmount * 100,
        brightnessPct: colorGradeSettings.brightnessAmount * 100,
        sepiaPct: colorGradeSettings.sepiaAmount * 100,
        tintPct: colorGradeSettings.tintAmount * 100,
        vignettePct: colorGradeSettings.vignetteAmount * 100,
        grainPct: (colorGradeSettings.grainAmount / GRAIN_MAX_INTENSITY) * 100,
        blurPct: colorGradeSettings.blurAmount * 100,
        dofEnabled: dofSettings.enabled,
        dofStrengthPct: dofSettings.strengthPct,
        dofFocusSlider: dofSettings.focusSlider,
        nightMode,
        horizonGlowEnabled,
        nightDaySnapshot,
        starBrightnessPct: colorGradeSettings.starBrightness * 100,
        moonAzimuthDeg: Cesium.Math.toDegrees(moonAzimuthRad),
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
  tintAmount: 0, // Blaustich (Nacht-Look), 0 = aus
  moonAmount: 0, // Mond (nur im Nacht-Modus), 0 = aus
  starBrightness: 1.5, // Helligkeit der Sterne/Skybox (nur im Nacht-Modus), 1 = unverändert, Standard 1.5
  vignetteAmount: 0.12, // 1 - bisheriger fixer Wert 0.88
  grainAmount: 0,
  blurAmount: 0,
};

// Miniatur-Effekt (Schärfentiefe/Tilt-Shift-Look): Cesiums eingebaute
// Depth-of-Field-Stage, tiefenbasiert - funktioniert daher bei jeder
// Blickrichtung/Steigung. Standardmäßig aus (kostet Leistung).
const DOF_FOCUS_MIN_M = 30;
const DOF_FOCUS_MAX_M = 3000;
const DOF_STRENGTH_DEFAULT_PCT = 60;
const DOF_FOCUS_DEFAULT_SLIDER = 50; // 0..100, logarithmisch -> ca. 300 m
let dofSettings = {
  enabled: false,
  strengthPct: DOF_STRENGTH_DEFAULT_PCT,
  focusSlider: DOF_FOCUS_DEFAULT_SLIDER,
};
let depthOfFieldStage = null;

// Nacht-Modus (Schalter im Filter-Block des Pausenmenüs, siehe applyNightMode).
// nightDaySnapshot merkt sich die Filterwerte von vor dem Umschalten, damit sie
// beim Ausschalten wiederhergestellt werden.
let nightMode = false;
let horizonGlowEnabled = true;
let nightDaySnapshot = null;

// Mond (nur im Nacht-Modus): wird im Farbkorrektur-Shader auf die Himmels-
// Pixel gezeichnet (also hinter Gelände/Gebäuden und ohne Nebel/Abdunklung).
// Er steht fest am lokalen Himmel (Azimut/Höhe über dem Horizont) und
// wandert beim Fliegen nicht weg. Der Azimut wird beim Einschalten nach der
// Halbkugel gesetzt (Nord -> Süden, Süd -> Norden), passend zu den in die
// 3D-Kacheln eingebrannten Schatten (siehe applyNightMode).
const MOON_ANGULAR_RADIUS_DEG = 1.2; // scheinbare Größe (real nur ca. 0.26°)
const MOON_ELEVATION_DEG = 10; // Höhe über dem Horizont
const MOON_AZIMUTH_OFFSET_DEG = 25; // nur noch Startwert vor dem ersten Einschalten
// moon.png wird halbtransparent über den prozeduralen Mond gelegt: so bleibt der
// Mond-Rand/Schein erhalten und die Krater-/Meer-Struktur kommt aus dem Foto.
const MOON_TEXTURE_URL = "/moon.png";
const MOON_TEXTURE_OPACITY = 0.85; // 0 = nur prozeduraler Mond, 1 = nur Foto
// Farbstich des Mondes (RGB-Faktor): (1,1,1) = neutral grau/weiß, kleineres Blau =
// wärmer/gelblicher, größeres Blau = kühler. Vorher (1.0, 0.98, 0.90) = deutlich gelb.
const MOON_TINT = new Cesium.Cartesian3(0.95, 0.97, 1.0);
const MOON_TEXTURE_BRIGHTNESS = 0.9; // das Foto ist recht dunkel -> aufhellen
let moonAzimuthRad = Cesium.Math.toRadians(MOON_AZIMUTH_OFFSET_DEG);

const moonScratchEnu = new Cesium.Matrix4();
const moonScratchLocal = new Cesium.Cartesian3();
const moonScratchWorld = new Cesium.Cartesian3();

// Mondrichtung in Weltkoordinaten: lokale Richtung (Ost/Nord/Oben) an der
// aktuellen Kameraposition -> Welt. Wird pro Frame als Shader-Uniform gelesen.
function computeMoonDirection() {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    viewer.camera.positionWC,
    Cesium.Ellipsoid.WGS84,
    moonScratchEnu,
  );
  const elevation = Cesium.Math.toRadians(MOON_ELEVATION_DEG);
  moonScratchLocal.x = Math.cos(elevation) * Math.sin(moonAzimuthRad);
  moonScratchLocal.y = Math.cos(elevation) * Math.cos(moonAzimuthRad);
  moonScratchLocal.z = Math.sin(elevation);
  Cesium.Matrix4.multiplyByPointAsVector(enu, moonScratchLocal, moonScratchWorld);
  return Cesium.Cartesian3.normalize(moonScratchWorld, moonScratchWorld);
}

function dofFocusMeters(slider) {
  return DOF_FOCUS_MIN_M * Math.pow(DOF_FOCUS_MAX_M / DOF_FOCUS_MIN_M, slider / 100);
}

function syncDepthOfField() {
  if (!depthOfFieldStage) return;
  depthOfFieldStage.enabled = dofSettings.enabled;
  depthOfFieldStage.uniforms.focalDistance = dofFocusMeters(dofSettings.focusSlider);
  depthOfFieldStage.uniforms.delta = 1.0;
  depthOfFieldStage.uniforms.sigma = 2.0;
  // Stärke = Unschärfe-Schrittweite (1 = kaum, 6 = deutlich)
  depthOfFieldStage.uniforms.stepSize = 1 + (dofSettings.strengthPct / 100) * 5;
}

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
  // Schärfentiefe (Miniatur-Effekt) vor Nebel/Farbkorrektur, standardmäßig aus.
  depthOfFieldStage = Cesium.PostProcessStageLibrary.createDepthOfFieldStage();
  viewer.scene.postProcessStages.add(depthOfFieldStage);
  syncDepthOfField();

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
        uniform float tintAmount;
        uniform float vignetteAmount;
        uniform float grainAmount;
        uniform float blurAmount;
        uniform sampler2D depthTexture;
        uniform float moonAmount;
        uniform float starBrightness;
        uniform vec3 moonDirection;
        uniform float moonRadius;
        uniform vec3 moonTint;
        uniform sampler2D moonTexture;
        uniform float moonTextureOpacity;
        uniform float moonTextureBrightness;
        in vec2 v_textureCoordinates;

        // Einfache Pseudo-Zufallszahl aus einem 2D-Vektor - Standardtrick
        // für GLSL, kein echter Zufall, aber ausreichend gleichverteilt/
        // hochfrequent für Filmkorn.
        float randomFromVec2(vec2 co) {
          return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
        }

        // Einfaches Value-Noise für die Mondoberfläche (dunklere "Meere").
        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = randomFromVec2(i);
          float b = randomFromVec2(i + vec2(1.0, 0.0));
          float c = randomFromVec2(i + vec2(0.0, 1.0));
          float d = randomFromVec2(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
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

          // Blaustich (kühle Nacht-Tönung): multipliziert einen bläulichen
          // Faktor auf das Bild - Rot/Grün werden abgesenkt, Blau bleibt.
          // tintAmount 0 = keine Wirkung.
          color.rgb *= mix(vec3(1.0), vec3(0.55, 0.65, 1.0), tintAmount);

          // Helligkeit / Abdunkeln
          color.rgb = clamp(color.rgb * brightnessAmount, 0.0, 1.0);

          // Vignette (dunklere Ecken), Stärke per Slider einstellbar -
          // vignetteAmount 0 = keine Abdunklung an den Ecken, 1 = Ecken
          // komplett schwarz.
          vec2 uv = v_textureCoordinates - 0.5;
          float vignette = smoothstep(0.8, 0.35, length(uv));
          color.rgb *= mix(1.0 - vignetteAmount, 1.0, vignette);

          // Mond: nur auf Himmels-Pixeln (Tiefe 1.0 = nichts gerendert), damit
          // Gelände und Gebäude ihn korrekt verdecken. Wird nach Helligkeit/
          // Tönung/Vignette gezeichnet, bleibt also hell und unverfärbt.
          if (moonAmount > 0.0) {
            float skyDepth = czm_unpackDepth(texture(depthTexture, v_textureCoordinates));
            if (skyDepth >= 1.0) {
              // Sterne/Skybox abdunkeln bzw. aufhellen, bevor Mond + Schein
              // gezeichnet werden (diese bleiben davon unberührt).
              color.rgb = clamp(color.rgb * starBrightness, 0.0, 1.0);

              vec4 eyePoint = czm_inverseProjection * vec4(v_textureCoordinates * 2.0 - 1.0, 0.0, 1.0);
              vec3 viewDirWorld = normalize(czm_inverseViewRotation * normalize(eyePoint.xyz / eyePoint.w));

              float moonAngle = acos(clamp(dot(viewDirWorld, moonDirection), -1.0, 1.0));
              float disk = 1.0 - smoothstep(moonRadius * 0.96, moonRadius, moonAngle);

              // 2D-Koordinaten auf der Mondscheibe (-1..1) für die Oberfläche
              vec3 moonHelper = normalize(czm_viewerPositionWC); // lokal "oben" -> Mond bleibt zum Horizont aufrecht
              vec3 moonTangent1 = normalize(cross(moonDirection, moonHelper));
              vec3 moonTangent2 = cross(moonDirection, moonTangent1);
              vec2 moonPoint = vec2(dot(viewDirWorld, moonTangent1), dot(viewDirWorld, moonTangent2)) / sin(moonRadius);
              float moonR2 = clamp(dot(moonPoint, moonPoint), 0.0, 1.0);

              float moonNoise = noise2(moonPoint * 3.0 + 7.0) * 0.6 + noise2(moonPoint * 8.0) * 0.4;
              float surface = 0.72 + 0.28 * smoothstep(0.3, 0.7, moonNoise);
              float limb = 0.85 + 0.15 * sqrt(1.0 - moonR2);
              vec3 moonColor = clamp(moonTint * surface * limb * 1.15, 0.0, 1.0);

              // moon.png halbtransparent darüberlegen (moonPoint.y zeigt nach
              // unten, die Textur wird mit Zeile 0 = oben abgetastet).
              vec2 moonUv = clamp(moonPoint * 0.5 + 0.5, 0.0, 1.0);
              vec4 moonTex = texture(moonTexture, moonUv);
              vec3 moonTexColor = clamp(moonTex.rgb * moonTextureBrightness, 0.0, 1.0) * moonTint;
              moonColor = mix(moonColor, moonTexColor, moonTex.a * moonTextureOpacity);

              // Weicher, leicht bläulicher Schein um den Mond
              float glow = exp(-pow(moonAngle / (moonRadius * 3.0), 2.0)) * 0.22
                         + exp(-pow(moonAngle / (moonRadius * 8.0), 2.0)) * 0.08;
              color.rgb += vec3(0.65, 0.75, 1.0) * glow * moonAmount;
              color.rgb = mix(color.rgb, moonColor, disk * moonAmount);
              color.rgb = clamp(color.rgb, 0.0, 1.0);
            }
          }

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
        tintAmount: () => colorGradeSettings.tintAmount,
        moonAmount: () => colorGradeSettings.moonAmount,
        starBrightness: () => colorGradeSettings.starBrightness,
        moonDirection: computeMoonDirection,
        moonRadius: () => Cesium.Math.toRadians(MOON_ANGULAR_RADIUS_DEG),
        moonTint: () => MOON_TINT,
        moonTexture: MOON_TEXTURE_URL,
        moonTextureOpacity: () => MOON_TEXTURE_OPACITY,
        moonTextureBrightness: () => MOON_TEXTURE_BRIGHTNESS,
        vignetteAmount: () => colorGradeSettings.vignetteAmount,
        grainAmount: () => colorGradeSettings.grainAmount,
        blurAmount: () => colorGradeSettings.blurAmount,
      },
    }),
  );
}

// Tag-/Nacht-Werte für den Tiefennebel (siehe Nacht-Modus weiter unten).
const DAY_FOG_COLOR = "#bed3e9";
const DAY_FOG_DENSITY = 0.00003;
const DAY_HORIZON_GLOW_COLOR = "#ead2c6";
const DAY_HORIZON_GLOW_AMOUNT = 0.3;
const DAY_HORIZON_GLOW_WIDTH = Cesium.Math.toRadians(6);
const DAY_HORIZON_HAZE_WIDTH = Cesium.Math.toRadians(15);
const NIGHT_FOG_COLOR = "#05080f";
const NIGHT_SKY_COLOR = "#05080f"; // Hintergrund, wenn die Himmelsatmosphäre aus ist
const NIGHT_FOG_DENSITY = 0.0000;

const depthFogSettings = {
  // Nebelfarbe: an die Himmelsfarbe angleichen, damit der Übergang zum
  // Horizont nicht wie ein grauer Vorhang wirkt, sondern wie natürlicher
  // Dunst. Bei Bedarf an Tageszeit/Wetter koppeln.
  color: Cesium.Color.fromCssColorString(DAY_FOG_COLOR),
  // Dichte fürs quadratisch-exponentielle Fog-Modell, siehe Shader unten.
  // Wirkt auf reale Meter-Distanzen (nicht auf die 0..1-Ellipsoid-Einheit
  // von viewer.scene.fog!) - deshalb ein ganz anderer Wertebereich.
  // Klein anfangen und hochtasten: 0.00003 blendet bei ca. 15-20 km
  // spürbar ein, bei ca. 40 km praktisch komplett zur Nebelfarbe.
  density: DAY_FOG_DENSITY,
};

// Tiefenbasierter Nebel als Post-Process-Stage. Anders als
// viewer.scene.fog (siehe Hinweis oben) wirkt das hier tatsächlich auf
// alles, was gerendert wurde - inklusive der Google Photorealistic 3D
// Tiles - weil wir direkt mit der Tiefentextur des fertigen Frames
// arbeiten statt uns auf ein Cesium-internes Fog-Feature zu verlassen,
// das nur für den Globe gebaut ist.
function addDepthFogPostProcess() {
  const fogSettings = depthFogSettings;
  const localUp = new Cesium.Cartesian3();

  const fragmentShader = `
    uniform sampler2D colorTexture;
    uniform sampler2D depthTexture;
    uniform vec4 fogColor;
    uniform float fogDensity;
    uniform bool horizonEnabled;
    uniform vec3 localUp;
    uniform vec4 horizonGlowColor;
    uniform float horizonGlowAmount;
    uniform float horizonGlowWidth;
    uniform float horizonHazeWidth;
    in vec2 v_textureCoordinates;

    void main() {
      vec4 sceneColor = texture(colorTexture, v_textureCoordinates);
      float depth = czm_unpackDepth(texture(depthTexture, v_textureCoordinates));
      vec3 hazeColor = fogColor.rgb;
      float horizonHaze = 0.0;

      if (horizonEnabled) {
        vec4 eyePoint = czm_inverseProjection * vec4(v_textureCoordinates * 2.0 - 1.0, 0.0, 1.0);
        vec3 viewDirection = normalize(czm_inverseViewRotation * normalize(eyePoint.xyz / eyePoint.w));
        float elevation = asin(clamp(dot(viewDirection, localUp), -1.0, 1.0));
        float glow = exp(-pow(elevation / horizonGlowWidth, 2.0));
        horizonHaze = exp(-pow(elevation / horizonHazeWidth, 2.0));
        hazeColor = mix(hazeColor, horizonGlowColor.rgb, glow * horizonGlowAmount);
      }

      if (depth == 0.0 || depth >= 1.0) {
        out_FragColor = vec4(mix(sceneColor.rgb, hazeColor, horizonHaze), sceneColor.a);
        return;
      }

      vec4 eyeCoordinate = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
      float dist = -eyeCoordinate.z / eyeCoordinate.w;
      float scalar = dist * fogDensity;
      float fogFactor = 1.0 - exp(-scalar * scalar);
      out_FragColor = vec4(mix(sceneColor.rgb, hazeColor, clamp(fogFactor, 0.0, 1.0)), sceneColor.a);
    }
  `;

  const stage = viewer.scene.postProcessStages.add(
    new Cesium.PostProcessStage({
      name: "depthFog",
      fragmentShader,
      uniforms: {
        fogColor: () => fogSettings.color,
        fogDensity: () => fogSettings.density,
        horizonEnabled: () => horizonGlowEnabled && !nightMode,
        localUp: () =>
          Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
            viewer.camera.positionWC,
            localUp,
          ),
        horizonGlowColor: Cesium.Color.fromCssColorString(DAY_HORIZON_GLOW_COLOR),
        horizonGlowAmount: DAY_HORIZON_GLOW_AMOUNT,
        horizonGlowWidth: DAY_HORIZON_GLOW_WIDTH,
        horizonHazeWidth: DAY_HORIZON_HAZE_WIDTH,
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

// Kleiner Wrapper um geocode() (siehe geocode.js, nutzt den Key des Spielers) -
// wird sowohl von der Ortssuche (geocodeAndFlyTo) als auch vom zufälligen
// Startort (loadGoogleTiles) genutzt.
async function fetchGeocode(query) {
  return geocode({ q: query });
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
      if (typeof usableSavedState.locationBannerEnabled === "boolean")
        applyLocationBannerEnabled(usableSavedState.locationBannerEnabled);
      if (Number.isFinite(usableSavedState.contrastPct))
        applyContrast(usableSavedState.contrastPct);
      if (Number.isFinite(usableSavedState.saturationPct))
        applySaturation(usableSavedState.saturationPct);
      if (Number.isFinite(usableSavedState.brightnessPct))
        applyBrightness(usableSavedState.brightnessPct);
      if (Number.isFinite(usableSavedState.sepiaPct))
        applySepia(usableSavedState.sepiaPct);
      if (Number.isFinite(usableSavedState.tintPct))
        applyTint(usableSavedState.tintPct);
      if (Number.isFinite(usableSavedState.vignettePct))
        applyVignette(usableSavedState.vignettePct);
      if (Number.isFinite(usableSavedState.grainPct))
        applyGrain(usableSavedState.grainPct);
      if (Number.isFinite(usableSavedState.blurPct))
        applyBlur(usableSavedState.blurPct);
      if (Number.isFinite(usableSavedState.dofStrengthPct))
        applyDofStrength(usableSavedState.dofStrengthPct);
      if (Number.isFinite(usableSavedState.dofFocusSlider))
        applyDofFocus(usableSavedState.dofFocusSlider);
      if (typeof usableSavedState.dofEnabled === "boolean")
        applyDofEnabled(usableSavedState.dofEnabled);
      if (Number.isFinite(usableSavedState.starBrightnessPct))
        applyStarBrightness(usableSavedState.starBrightnessPct);
      if (Number.isFinite(usableSavedState.moonAzimuthDeg))
        moonAzimuthRad = Cesium.Math.toRadians(usableSavedState.moonAzimuthDeg);
      if (typeof usableSavedState.nightMode === "boolean") {
        nightDaySnapshot = usableSavedState.nightDaySnapshot ?? null;
        // Gespeicherte Filterwerte gelten schon - nicht erneut preseten.
        applyNightMode(usableSavedState.nightMode, { applyFilters: false });
      }
      applyHorizonGlowEnabled(usableSavedState.horizonGlowEnabled !== false);
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
        } else {
          console.warn("Geocoding fehlgeschlagen:", data.status, data.error);
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
    // zufälligen Startort. Gasstellung auf HOVER_THROTTLE (siehe
    // setCruiseVelocity), damit man in Level-Fluglage weder steigt noch
    // fällt, bis man selbst gast.
    setCruiseVelocity(125 / 3.6); // 125 km/h in m/s

    setStatus(readyStatusText);
    setStatusVisible(false);
    maybeShowControlsHelpOnce();
  } catch (err) {
    setStatus("Fehler beim Laden der 3D Tiles - API-Key prüfen");
    loadingOverlayEl.classList.add("hidden");
    console.error(err);
    // Scheitert schon das Anlegen des Tilesets (tileset noch undefined), liegt
    // es meist am Key: ungültig, Map Tiles API nicht aktiviert oder keine
    // Abrechnung. Dann Dialog erneut zeigen und nach neuer Eingabe neu laden.
    if (!tileset) {
      await requestApiKey({
        error:
          "Die 3D Tiles konnten nicht geladen werden. Prüfe, ob die Map Tiles API aktiviert ist, die Abrechnung eingerichtet ist und der Key stimmt, und gib den Key erneut ein.",
      });
      location.reload();
    }
  }
}

// Start: ohne gespeicherten Key zuerst den Eingabe-Dialog mit Anleitung zeigen.
async function startApp() {
  let key = getApiKey();
  if (!key) key = await requestApiKey();
  Cesium.GoogleMaps.defaultApiKey = key;
  await loadGoogleTiles();
}

startApp();


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
  // Mit verbundenem Controller: Drohne statt Flugzeug-Symbol.
  minimapMarkerEl.classList.toggle("drone", connectedGamepadIndex !== null);
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

// --- Einstellungen-Menü (Zahnrad links neben dem Hilfe-Button) ------------
// Erster Eintrag: Google-API-Key ändern. Neuer Key -> Neuladen, damit Tiles und
// Ortsabfragen sauber mit dem neuen Key starten.
const settingsMenuButton = document.getElementById("settings-menu-button");
const settingsMenuEl = document.getElementById("settings-menu");
const settingsApiKeyItem = document.getElementById("settings-api-key-item");

function setSettingsMenuOpen(open) {
  settingsMenuEl.hidden = !open;
  settingsMenuButton.setAttribute("aria-expanded", String(open));
}

settingsMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setSettingsMenuOpen(settingsMenuEl.hidden);
});

// Klick irgendwo anders schließt das Menü wieder.
document.addEventListener("click", (event) => {
  if (!settingsMenuEl.hidden && !settingsMenuEl.contains(event.target)) {
    setSettingsMenuOpen(false);
  }
});

settingsApiKeyItem.addEventListener("click", async () => {
  setSettingsMenuOpen(false);
  const newKey = await requestApiKey({ cancellable: true });
  if (newKey) location.reload();
});

// --- Vollbild-Button (Ersatz für Cesiums Standard-Fullscreen-Button) -----
// Gleiche runde Icon-Button-Optik wie #controls-help-button/#search-panel-
// close, nur oben rechts über dem gesamten Viewport fest positioniert (siehe
// CSS) und - wie zuvor Cesiums eigener Button - ausschließlich im Pausen-
// modus sichtbar.
const fullscreenToggleButton = document.getElementById(
  "fullscreen-toggle-button",
);
const fullscreenExpandIcon = document.getElementById("fullscreen-icon-expand");
const fullscreenCompressIcon = document.getElementById(
  "fullscreen-icon-compress",
);

if (Cesium.Fullscreen.enabled) {
  fullscreenToggleButton.addEventListener("click", () => {
    if (Cesium.Fullscreen.fullscreen) {
      Cesium.Fullscreen.exitFullscreen();
    } else {
      Cesium.Fullscreen.requestFullscreen(document.body);
    }
  });

  document.addEventListener(Cesium.Fullscreen.changeEventName, () => {
    const isFullscreen = Cesium.Fullscreen.fullscreen;
    fullscreenExpandIcon.classList.toggle("fullscreen-icon-hidden", isFullscreen);
    fullscreenCompressIcon.classList.toggle(
      "fullscreen-icon-hidden",
      !isFullscreen,
    );
    fullscreenToggleButton.setAttribute(
      "aria-label",
      isFullscreen ? "Vollbild beenden" : "Vollbild aktivieren",
    );
  });
} else {
  // Browser unterstützt keine Fullscreen-API (z.B. manche mobilen Browser) -
  // dann lieber den Button ganz ausblenden statt einen funktionslosen
  // Button anzuzeigen.
  fullscreenToggleButton.hidden = true;
}

// --- Künstlicher Horizont ------------------------------------------------
// Zeigt die tatsächliche Fluglage (pitch/roll der Steuerung), bewusst OHNE
// den Kamera-Blickwinkel-Offset (siehe cameraTiltOffset weiter unten) - das
// Instrument soll die Lage des "Fluggeräts" anzeigen, nicht wohin die
// (davon unabhängige) Kamera gerade schaut.
const horizonBallEl = document.getElementById("horizon-ball");
const horizonRollPointerEl = document.getElementById("horizon-roll-pointer");
const HORIZON_PX_PER_DEGREE = 3; // Pixel Verschiebung der Kugel pro Grad Pitch

function updateHorizon() {
  // Über der Senkrechten (|Pitch| > 90°, z.B. im Looping) zeigt ein echter
  // künstlicher Horizont Rückenlage: Pitch spiegelt zurück, Roll +180°.
  let pitchShown = pitch;
  let rollShown = roll;
  if (Math.abs(pitchShown) > Math.PI / 2) {
    pitchShown = Math.sign(pitchShown) * Math.PI - pitchShown;
    rollShown += Math.PI;
  }
  const pitchDeg = Cesium.Math.toDegrees(pitchShown);
  const rollDeg = Cesium.Math.toDegrees(rollShown);

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
// Vorgabewert passend zur Drohnen-/FPV-Ansicht (kein Flugzeug-Modell
// sichtbar bzw. echter Controller verbunden) - siehe applyDroneViewDefaults()
// weiter unten, das genau diese Werte (FOV + Kamera-Blickwinkel) setzt.
const FOV_DEFAULT_DEG = 90;
// Vorgabe im Flug-Modus (ohne Controller)
const FOV_FLIGHT_DEFAULT_DEG = 80;

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
applyFov(FOV_FLIGHT_DEFAULT_DEG);

// --- Bildformat (Ausschnitt) ---------------------------------------------
// Schneidet den Viewer auf ein festes Seitenverhältnis zu (Letterbox/
// Pillarbox), um zu testen, wie sich das Fliegen bei breitem vs. fast
// quadratischem Ausschnitt anfühlt. Achtung: Cesiums FOV gilt bei
// Breite > Höhe horizontal - bei gleichem FOV-Wert wird der Ausschnitt
// also höher, nicht schmaler beschnitten.
const ASPECT_KEY = "flymaps_view_aspect";
const ASPECT_DRONE_DEFAULT = "5/4"; // Vorgabe mit Controller
const ASPECT_FLIGHT_DEFAULT = "auto"; // Vorgabe im Flug-Modus (Vollbild)
const aspectSelect = document.getElementById("aspect-select");

function applyViewAspect(value) {
  const [w, h] = value === "auto" ? [0, 0] : value.split("/").map(Number);
  const cropped = w > 0 && h > 0;
  document.body.classList.toggle("view-cropped", cropped);
  if (cropped) document.body.style.setProperty("--view-aspect", w / h);
  else document.body.style.removeProperty("--view-aspect");
  aspectSelect.value = cropped ? value : "auto";
}

aspectSelect.addEventListener("change", () => {
  applyViewAspect(aspectSelect.value);
  try {
    localStorage.setItem(ASPECT_KEY, aspectSelect.value);
  } catch {
    // localStorage kann z.B. im privaten Modus fehlschlagen - dann eben ohne Persistenz
  }
  // Selectbox behält sonst den Fokus - Tastatursteuerung (Pfeiltasten)
  // würde sonst die Auswahl ändern statt zu fliegen.
  aspectSelect.blur();
});

try {
  applyViewAspect(localStorage.getItem(ASPECT_KEY) ?? "auto");
} catch {
  applyViewAspect("auto");
}

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
const CAMERA_TILT_MAX_DEG = 60; // maximal nach oben
// Siehe FOV_DEFAULT_DEG oben - derselbe Drohnen-/FPV-Hintergrund.
const CAMERA_TILT_DEFAULT_DEG = 45;
// Flug-Pitch (bis PITCH_MAX) + Kamera-Tilt-Offset addiert sich. Im
// Tastatur-Flug hart gedeckelt knapp unter +-90°, damit die Kamera nie
// "durchschlägt"/kippt. Mit Controller (Acro, unbegrenzter Pitch) gibt es
// KEIN Limit: Cesiums setView akzeptiert beliebige Pitch-Winkel, Pitch über
// 90° ergibt dann einfach die Rückenlage - das ist nötig für volle Loopings.
const RENDER_PITCH_LIMIT = Cesium.Math.toRadians(89);
function clampedRenderPitch(offset) {
  if (isDroneView()) return wrapAngle(pitch + offset);
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
// Ohne Controller startet die Kamera geradeaus (0°); die 50° FPV-Neigung
// gilt erst, wenn ein Controller verbunden ist (applyDroneViewDefaults).
const CAMERA_TILT_FLIGHT_DEFAULT_DEG = -10; // Vorgabe im Flug-Modus (ohne Controller)
applyCameraTilt(CAMERA_TILT_FLIGHT_DEFAULT_DEG);

// Setzt FOV + Kamera-Blickwinkel auf die Drohnen-/FPV-Vorgabewerte zurück
// (siehe FOV_DEFAULT_DEG/CAMERA_TILT_DEFAULT_DEG oben) - wird beim
// Verbinden eines Controllers sowie beim manuellen Ausschalten von
// "Flugzeug anzeigen" aufgerufen (siehe applyPlaneVisible-Abschnitt und
// gamepadconnected-Listener weiter unten).
function applyDroneViewDefaults() {
  const drone = isDroneView();
  applyFov(drone ? FOV_DEFAULT_DEG : FOV_FLIGHT_DEFAULT_DEG);
  applyCameraTilt(drone ? CAMERA_TILT_DEFAULT_DEG : CAMERA_TILT_FLIGHT_DEFAULT_DEG);
  applyViewAspect(drone ? ASPECT_DRONE_DEFAULT : ASPECT_FLIGHT_DEFAULT);
}

// Ein echter Controller ist angeschlossen - dann soll der künstliche
// Horizont (#horizon-wrapper) ausgeblendet werden, siehe
// updateHorizonVisibility() unten. Bewusst NICHT an "Flugzeug anzeigen"
// gekoppelt (anders als noch in einer früheren Fassung) - nur die
// Controller-Verbindung selbst entscheidet.
function isDroneView() {
  return connectedGamepadIndex !== null;
}

const horizonWrapperEl = document.getElementById("horizon-wrapper");
const flightDataEl = document.getElementById("flight-data");
// Deckungsgleich mit den bottom-Werten in style.css: #flight-data sitzt
// normalerweise über #horizon-wrapper (192px), rutscht aber auf dessen
// Position (40px) runter, wenn der Horizont bei verbundenem Controller
// ausgeblendet ist - sonst würde die Box über der leeren Lücke "schweben".
const FLIGHT_DATA_BOTTOM_WITH_HORIZON_PX = 192;
const FLIGHT_DATA_BOTTOM_WITHOUT_HORIZON_PX = 40;

function updateHorizonVisibility() {
  const droneView = isDroneView();
  if (horizonWrapperEl) horizonWrapperEl.hidden = droneView;
  if (flightDataEl) {
    flightDataEl.style.bottom = `${
      droneView
        ? FLIGHT_DATA_BOTTOM_WITHOUT_HORIZON_PX
        : FLIGHT_DATA_BOTTOM_WITH_HORIZON_PX
    }px`;
  }
}
updateHorizonVisibility(); // Initialzustand (kein Controller beim Start verbunden)

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
  const visible = planeVisibleToggle.checked;
  applyPlaneVisible(visible);
  // Nur bei diesem manuellen Deaktivieren zusätzlich auf die Drohnen-
  // Vorgabewerte (FOV + Blickwinkel) zurücksetzen, statt beim zuvor fest
  // eingestellten Cockpit-Winkel (PLANE_FIXED_TILT_DEG) hängen zu bleiben.
  // Beim Laden von gespeicherten Orten/Favoriten (applyPlaneVisible-Aufrufe
  // weiter oben) bleibt der dort jeweils gespeicherte Kamera-Winkel dagegen
  // unangetastet, damit applyCameraTilt(usableSavedState.cameraTiltDegrees)
  // nicht überschrieben wird.
  if (!visible) applyDroneViewDefaults();
  saveCameraState();
  // Direkt sichtbar auch während der Pause (Tick-Handler läuft dann nicht,
  // siehe gleiches Muster beim cameraTiltSlider-input-Handler weiter oben):
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
applyPlaneVisible(planeVisible); // Initialzustand (Regler-Sichtbarkeit + Tilt)

// "Anzeigen"-Schalter - an = HUD, Speed/Höhe, Minimap, Horizont und
// Google-Attribution sichtbar; aus = "Nur Landschaft" (siehe body.hide-hud-Regel in style.css).
let hudHidden = false;
const hideHudToggle = document.getElementById("hide-hud-toggle");

function applyHudHidden(hidden) {
  hudHidden = hidden;
  hideHudToggle.checked = !hidden; // Checkbox = "Anzeigen" -> invertiert
  document.body.classList.toggle("hide-hud", hidden);
}

hideHudToggle.addEventListener("change", () => {
  applyHudHidden(!hideHudToggle.checked);
  saveCameraState();
});
applyHudHidden(hudHidden);

// --- Standort-Banner ("Bauchbinde") -------------------------------------
// Zeigt beim Überfliegen einer neuen Region kurz Ort + Land ein (siehe
// updateLocationBanner() im Tick-Handler weiter unten). Nutzt denselben
// Geocoding (geocode.js) wie die Ortssuche und "Aktueller Ort" im Pausenmenü,
// hier aber mit latlng und den zusätzlichen place/country-Feldern (siehe
// geocode.js). Per Schalter im Menü optional abschaltbar.
let locationBannerEnabled = true;
const locationBannerToggle = document.getElementById(
  "location-banner-toggle",
);
const locationBannerEl = document.getElementById("location-banner");
const locationBannerPlaceEl = document.getElementById(
  "location-banner-place",
);
const locationBannerDistrictEl = document.getElementById(
  "location-banner-district",
);
const locationBannerCountryEl = document.getElementById(
  "location-banner-country",
);

function applyLocationBannerEnabled(enabled) {
  locationBannerEnabled = enabled;
  locationBannerToggle.checked = enabled;
  if (!enabled) hideLocationBanner();
}

locationBannerToggle.addEventListener("change", () => {
  applyLocationBannerEnabled(locationBannerToggle.checked);
  saveCameraState();
});
applyLocationBannerEnabled(locationBannerEnabled);

// Nur die zuletzt angezeigte Region merken (nicht jede Zwischenanfrage) -
// so wird die Bauchbinde nur beim tatsächlichen Wechsel neu eingeblendet,
// nicht bei jedem Poll-Intervall.
let lastShownLocationKey = null;
// Entprellung: ein neuer Ort wird erst übernommen, wenn er bei zwei
// aufeinanderfolgenden Abfragen (mit dem üblichen Zeit-/Distanz-Abstand
// dazwischen) gleich ist. Verhindert, dass an Verwaltungsgrenzen (z.B. eine
// winzige italienische Contrada direkt an der Gemeindegrenze) kurz
// hintereinander mehrere unterschiedliche Namen aufblitzen.
let pendingLocationKey = null;
let pendingLocationConfirmCount = 0;
let locationBannerHideTimeout = null;
let locationBannerRequestId = 0;
// Throttling: sowohl Mindestabstand in Zeit als auch in Distanz seit der
// letzten Anfrage, damit im Reiseflug (kaum Kursänderung über mehrere
// Sekunden) nicht unnötig oft die kostenpflichtige Geocoding API
// angefragt wird.
const LOCATION_BANNER_CHECK_INTERVAL_MS = 5000;
const LOCATION_BANNER_CHECK_MIN_DISTANCE_M = 800;
const LOCATION_BANNER_VISIBLE_MS = 9000;
let lastLocationCheckTime = 0;
let lastLocationCheckPosition = null;

function showLocationBanner(place, district, country) {
  locationBannerPlaceEl.textContent = place;
  locationBannerDistrictEl.textContent = district ?? "";
  locationBannerCountryEl.textContent = country ?? "";
  locationBannerEl.classList.add("visible");

  if (locationBannerHideTimeout) clearTimeout(locationBannerHideTimeout);
  locationBannerHideTimeout = setTimeout(
    hideLocationBanner,
    LOCATION_BANNER_VISIBLE_MS,
  );
}

function hideLocationBanner() {
  locationBannerEl.classList.remove("visible");
  if (locationBannerHideTimeout) {
    clearTimeout(locationBannerHideTimeout);
    locationBannerHideTimeout = null;
  }
}

async function updateLocationBanner(now) {
  if (!locationBannerEnabled) return;

  const cameraPosition = viewer.camera.positionWC;
  if (
    lastLocationCheckPosition &&
    now - lastLocationCheckTime < LOCATION_BANNER_CHECK_INTERVAL_MS &&
    Cesium.Cartesian3.distance(cameraPosition, lastLocationCheckPosition) <
      LOCATION_BANNER_CHECK_MIN_DISTANCE_M
  ) {
    return;
  }
  lastLocationCheckTime = now;
  lastLocationCheckPosition = Cesium.Cartesian3.clone(cameraPosition);

  const carto = Cesium.Cartographic.fromCartesian(cameraPosition);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);

  const requestId = ++locationBannerRequestId;
  try {
    const data = await geocode({ latlng: `${lat},${lon}` });
    if (requestId !== locationBannerRequestId) return; // veraltete Antwort
    if (data.status !== "OK" || !data.place) return;

    // Viertel gehört zum Schlüssel: auch ein Wechsel innerhalb derselben
    // Stadt (z.B. Nördliche Innenstadt -> Paulusviertel) blendet die
    // Bauchbinde neu ein - mit der üblichen Bestätigung über zwei Abfragen.
    const key = `${data.place}|${data.district ?? ""}|${data.country ?? ""}`;
    if (key === lastShownLocationKey) {
      pendingLocationKey = null; // wird schon angezeigt, nichts zu bestätigen
      return;
    }
    if (key === pendingLocationKey) {
      pendingLocationConfirmCount++;
    } else {
      pendingLocationKey = key;
      pendingLocationConfirmCount = 1;
    }
    if (pendingLocationConfirmCount < 2) return; // noch nicht bestätigt

    lastShownLocationKey = key;
    showLocationBanner(data.place, data.district, data.country);
  } catch (err) {
    if (requestId !== locationBannerRequestId) return;
    console.error(err);
  }
}

// --- Sehenswürdigkeiten in der Nähe (Wikidata, siehe discover.js) ---------
const discovery = initDiscovery();

function updateDiscovery(now) {
  const camera = viewer.camera;
  const carto = Cesium.Cartographic.fromCartesian(camera.positionWC);
  discovery.update(
    now,
    Cesium.Math.toDegrees(carto.latitude),
    Cesium.Math.toDegrees(carto.longitude),
    camera.heading,
  );
}

// X: nächste, Y: vorherige Sehenswürdigkeit in der Nähe. e.code statt e.key,
// damit die Tasten (wie WASD) an ihrer Position bleiben: auf deutscher
// Tastatur liegt "Y" auf KeyZ, "X" auf KeyX - beide direkt nebeneinander.
// Mit Strg/Cmd/Alt ignorieren.
window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyZ" && e.code !== "KeyX") return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingInFormField(e.target)) return;
  if (controlsPanel.classList.contains("visible")) return;
  e.preventDefault();
  discovery.cycleTarget(e.code === "KeyX" ? 1 : -1);
});

// C: Sehenswürdigkeiten-Funktion ein-/ausschalten (wie der Schalter im
// Pausenmenü, #discovery-toggle - setEnabled() hält beide synchron).
const discoveryToggleEl = document.getElementById("discovery-toggle");
window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyC") return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingInFormField(e.target)) return;
  if (controlsPanel.classList.contains("visible")) return;
  e.preventDefault();
  discovery.setEnabled(!discoveryToggleEl.checked);
});

// Controller-Schalter (Achse 4): Jeder Wechsel der Schalterstellung schaltet
// die Sehenswürdigkeiten um (gleiche Wirkung wie Taste C). Die Startstellung
// beim ersten Auslesen wird nur gemerkt, nicht als Umschaltung gewertet.
// Hysterese (an > 0.5, aus < 0.2) gegen Flackern; bei einem 3-Stufen-Schalter
// zählt nur die obere Stellung als "an".
const DISCOVERY_TOGGLE_AXIS = 4;
let discoveryAxisActive = null;

function pollDiscoveryAxis() {
  if (connectedGamepadIndex === null) {
    discoveryAxisActive = null; // beim erneuten Verbinden neu einlesen
    return;
  }
  const gp = navigator.getGamepads()[connectedGamepadIndex];
  if (!gp || !gp.axes || gp.axes.length <= DISCOVERY_TOGGLE_AXIS) return;
  const v = gp.axes[DISCOVERY_TOGGLE_AXIS];
  let active = discoveryAxisActive === null ? v > 0.5 : discoveryAxisActive;
  if (!active && v > 0.5) active = true;
  else if (active && v < 0.2) active = false;
  if (discoveryAxisActive !== null && active !== discoveryAxisActive) {
    discovery.setEnabled(!discoveryToggleEl.checked);
  }
  discoveryAxisActive = active;
}

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
const CONTRAST_MIN_PCT = 0;
const CONTRAST_MAX_PCT = 150;
const CONTRAST_DEFAULT_PCT = 105;

const SATURATION_MIN_PCT = 0;
const SATURATION_MAX_PCT = 150;
const SATURATION_DEFAULT_PCT = 110;

const BRIGHTNESS_MIN_PCT = 0;
const BRIGHTNESS_MAX_PCT = 150;
const BRIGHTNESS_DEFAULT_PCT = 95;

const SEPIA_MIN_PCT = 0;
const SEPIA_MAX_PCT = 150;
const SEPIA_DEFAULT_PCT = 5;

// Blaustich: 0% = aus (Standard), wird vom Nacht-Modus per Preset gesetzt.
const TINT_MIN_PCT = 0;
const TINT_MAX_PCT = 150;
const TINT_DEFAULT_PCT = 0;

// Vignette: Prozentwert = Abdunklung an den Ecken direkt in vignetteAmount
// (siehe Shader oben, 0% = kein Vignetting, 60% = Ecken auf 40% Helligkeit
// abgedunkelt). Default 12% entspricht dem bisherigen fixen Wert (0.88).
const VIGNETTE_MIN_PCT = 0;
const VIGNETTE_MAX_PCT = 150;
const VIGNETTE_DEFAULT_PCT = 15;

// Filmkorn: 0% = aus (Standard), 100% = deutlich sichtbares Korn. Wird im
// Shader auf eine maximale Rauschamplitude von 0.15 gemappt (siehe
// applyGrain unten) - höher wirkt schnell wie Bildrauschen statt Filmkorn.
const GRAIN_MIN_PCT = 0;
const GRAIN_MAX_PCT = 150;
const GRAIN_DEFAULT_PCT = 8;
const GRAIN_MAX_INTENSITY = 0.15;

const BLUR_MIN_PCT = 0;
const BLUR_MAX_PCT = 150;
const BLUR_DEFAULT_PCT = 5;

const contrastSlider = document.getElementById("contrast-slider");
const contrastValueEl = document.getElementById("contrast-value");
const saturationSlider = document.getElementById("saturation-slider");
const saturationValueEl = document.getElementById("saturation-value");
const brightnessSlider = document.getElementById("brightness-slider");
const brightnessValueEl = document.getElementById("brightness-value");
const sepiaSlider = document.getElementById("sepia-slider");
const sepiaValueEl = document.getElementById("sepia-value");
const tintSlider = document.getElementById("tint-slider");
const tintValueEl = document.getElementById("tint-value");
const vignetteSlider = document.getElementById("vignette-slider");
const vignetteValueEl = document.getElementById("vignette-value");
const grainSlider = document.getElementById("grain-slider");
const grainValueEl = document.getElementById("grain-value");
// Sternhelligkeit: nur im Nacht-Modus sichtbar/wirksam, bewusst nicht Teil der
// Filter-Presets/Favoriten.
const starBrightnessRow = document.getElementById("star-brightness-row");
const starBrightnessSlider = document.getElementById("star-brightness-slider");
const starBrightnessValueEl = document.getElementById("star-brightness-value");
const STAR_BRIGHTNESS_MIN_PCT = 0;
const STAR_BRIGHTNESS_MAX_PCT = 150;
const STAR_BRIGHTNESS_DEFAULT_PCT = 150;
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

function applyTint(pct) {
  const clamped = Cesium.Math.clamp(pct, TINT_MIN_PCT, TINT_MAX_PCT);
  colorGradeSettings.tintAmount = clamped / 100;
  tintSlider.value = clamped;
  tintValueEl.textContent = `${Math.round(clamped)}%`;
}

function applyVignette(pct) {
  const clamped = Cesium.Math.clamp(pct, VIGNETTE_MIN_PCT, VIGNETTE_MAX_PCT);
  colorGradeSettings.vignetteAmount = clamped / 100;
  vignetteSlider.value = clamped;
  vignetteValueEl.textContent = `${Math.round(clamped)}%`;
}

function applyStarBrightness(pct) {
  const clamped = Cesium.Math.clamp(
    pct,
    STAR_BRIGHTNESS_MIN_PCT,
    STAR_BRIGHTNESS_MAX_PCT,
  );
  colorGradeSettings.starBrightness = clamped / 100;
  starBrightnessSlider.value = clamped;
  starBrightnessValueEl.textContent = `${Math.round(clamped)}%`;
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
tintSlider.min = TINT_MIN_PCT;
tintSlider.max = TINT_MAX_PCT;
applyTint(TINT_DEFAULT_PCT);
vignetteSlider.min = VIGNETTE_MIN_PCT;
vignetteSlider.max = VIGNETTE_MAX_PCT;
applyVignette(VIGNETTE_DEFAULT_PCT);
grainSlider.min = GRAIN_MIN_PCT;
grainSlider.max = GRAIN_MAX_PCT;
applyGrain(GRAIN_DEFAULT_PCT);
blurSlider.min = BLUR_MIN_PCT;
blurSlider.max = BLUR_MAX_PCT;
applyBlur(BLUR_DEFAULT_PCT);
starBrightnessSlider.min = STAR_BRIGHTNESS_MIN_PCT;
starBrightnessSlider.max = STAR_BRIGHTNESS_MAX_PCT;
applyStarBrightness(STAR_BRIGHTNESS_DEFAULT_PCT);
starBrightnessSlider.addEventListener("input", () => {
  applyStarBrightness(Number(starBrightnessSlider.value));
  saveCameraState();
});

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
tintSlider.addEventListener("input", () => {
  applyTint(Number(tintSlider.value));
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

// --- Miniatur-Effekt (Schärfentiefe) ---------------------------------------
const dofToggle = document.getElementById("dof-toggle");
const dofStrengthRow = document.getElementById("dof-strength-row");
const dofStrengthSlider = document.getElementById("dof-strength-slider");
const dofStrengthValueEl = document.getElementById("dof-strength-value");
const dofFocusRow = document.getElementById("dof-focus-row");
const dofFocusSlider = document.getElementById("dof-focus-slider");
const dofFocusValueEl = document.getElementById("dof-focus-value");

function applyDofEnabled(enabled) {
  dofSettings.enabled = enabled;
  dofToggle.checked = enabled;
  dofStrengthRow.hidden = !enabled;
  dofFocusRow.hidden = !enabled;
  syncDepthOfField();
}

function applyDofStrength(pct) {
  const clamped = Cesium.Math.clamp(pct, 0, 100);
  dofSettings.strengthPct = clamped;
  dofStrengthSlider.value = clamped;
  dofStrengthValueEl.textContent = `${Math.round(clamped)}%`;
  syncDepthOfField();
}

function applyDofFocus(sliderValue) {
  const clamped = Cesium.Math.clamp(sliderValue, 0, 100);
  dofSettings.focusSlider = clamped;
  dofFocusSlider.value = clamped;
  dofFocusValueEl.textContent = `${Math.round(dofFocusMeters(clamped))} m`;
  syncDepthOfField();
}

dofToggle.addEventListener("change", () => {
  applyDofEnabled(dofToggle.checked);
  saveCameraState();
  // Fokus von der Checkbox nehmen, damit die Tastatursteuerung nicht hängt.
  dofToggle.blur();
});
dofStrengthSlider.addEventListener("input", () => {
  applyDofStrength(Number(dofStrengthSlider.value));
  saveCameraState();
});
dofFocusSlider.addEventListener("input", () => {
  applyDofFocus(Number(dofFocusSlider.value));
  saveCameraState();
});
applyDofStrength(DOF_STRENGTH_DEFAULT_PCT);
applyDofFocus(DOF_FOCUS_DEFAULT_SLIDER);
applyDofEnabled(false);

// "Zurücksetzen"-Button: stellt den ursprünglichen, fest verdrahteten
// "kinematischen" Look wieder her (Kontrast 108%, Sättigung 112%,
// Vignette 12% - dieselben Werte wie CONTRAST_DEFAULT_PCT/
// SATURATION_DEFAULT_PCT/VIGNETTE_DEFAULT_PCT oben), Helligkeit/Sepia/
// Filmkorn auf ihren jeweiligen Aus-Zustand (100%/0%/0%).
const FILTER_DEFAULTS = {
  contrastPct: CONTRAST_DEFAULT_PCT,
  saturationPct: SATURATION_DEFAULT_PCT,
  brightnessPct: BRIGHTNESS_DEFAULT_PCT,
  sepiaPct: SEPIA_DEFAULT_PCT,
  tintPct: TINT_DEFAULT_PCT,
  vignettePct: VIGNETTE_DEFAULT_PCT,
  grainPct: GRAIN_DEFAULT_PCT,
  blurPct: BLUR_DEFAULT_PCT,
};

// Filter-Preset für den Nacht-Modus: abgedunkelt und entsättigt mit kühlem
// Blaustich, dezente Vignette, leichtes Korn, kein Blur.
const NIGHT_FILTER_PRESET = {
  contrastPct: 105,
  saturationPct: 40,
  brightnessPct: 50,
  sepiaPct: 5,
  tintPct: 70,
  vignettePct: 30,
  grainPct: 5,
  blurPct: 0,
};

function currentFilterValues() {
  return {
    contrastPct: colorGradeSettings.contrastAmount * 100,
    saturationPct: colorGradeSettings.saturationAmount * 100,
    brightnessPct: colorGradeSettings.brightnessAmount * 100,
    sepiaPct: colorGradeSettings.sepiaAmount * 100,
    tintPct: colorGradeSettings.tintAmount * 100,
    vignettePct: colorGradeSettings.vignetteAmount * 100,
    grainPct: (colorGradeSettings.grainAmount / GRAIN_MAX_INTENSITY) * 100,
    blurPct: colorGradeSettings.blurAmount * 100,
  };
}

function applyFilterValues(values) {
  applyContrast(values.contrastPct);
  applySaturation(values.saturationPct);
  applyBrightness(values.brightnessPct);
  applySepia(values.sepiaPct);
  applyTint(values.tintPct ?? TINT_DEFAULT_PCT);
  applyVignette(values.vignettePct);
  applyGrain(values.grainPct);
  applyBlur(values.blurPct);
}

// "Zurücksetzen"-Button: stellt den ursprünglichen Look wieder her - im
// Nacht-Modus entsprechend das Nacht-Preset statt der Tageswerte.
const filtersResetButton = document.getElementById("filters-reset-button");
filtersResetButton.addEventListener("click", () => {
  applyFilterValues(nightMode ? NIGHT_FILTER_PRESET : FILTER_DEFAULTS);
  applyDofStrength(DOF_STRENGTH_DEFAULT_PCT);
  applyDofFocus(DOF_FOCUS_DEFAULT_SLIDER);
  applyDofEnabled(false);
  applyHorizonGlowEnabled(true);
  saveCameraState();
});

const horizonGlowToggle = document.getElementById("horizon-glow-toggle");

function applyHorizonGlowEnabled(enabled) {
  horizonGlowEnabled = enabled;
  horizonGlowToggle.checked = enabled;
}

horizonGlowToggle.addEventListener("change", () => {
  applyHorizonGlowEnabled(horizonGlowToggle.checked);
  saveCameraState();
  horizonGlowToggle.blur();
});

// --- Nacht-Modus -----------------------------------------------------------
// Sehr dunkelblauer, dichterer Tiefennebel (die Fernsicht fällt ins Dunkel),
// keine Himmelsatmosphäre (dunkler Himmel mit Sternen) und die Filter auf das
// Nacht-Preset. Beim Ausschalten kommen die vorherigen Filterwerte zurück.
const nightModeToggle = document.getElementById("night-mode-toggle");

function applyNightMode(enabled, { applyFilters = true } = {}) {
  const wasNight = nightMode;
  nightMode = enabled;
  nightModeToggle.checked = enabled;

  depthFogSettings.color = Cesium.Color.fromCssColorString(
    enabled ? NIGHT_FOG_COLOR : DAY_FOG_COLOR,
  );
  depthFogSettings.density = enabled ? NIGHT_FOG_DENSITY : DAY_FOG_DENSITY;
  viewer.scene.skyAtmosphere.show = !enabled;
  colorGradeSettings.moonAmount = enabled ? 1 : 0;
  starBrightnessRow.style.display = enabled ? "" : "none";
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(
    enabled ? NIGHT_SKY_COLOR : "#000",
  );

  if (!applyFilters || enabled === wasNight) return;
  if (enabled) {
    // Mond zur Sonnenrichtung der eingebrannten Schatten passend platzieren:
    // Nordhalbkugel -> Süden (Azimut 180°), Südhalbkugel -> Norden (0°).
    const cameraLatitude = Cesium.Cartographic.fromCartesian(
      viewer.camera.positionWC,
    ).latitude;
    moonAzimuthRad = cameraLatitude >= 0 ? Math.PI : 0;
    nightDaySnapshot = currentFilterValues();
    applyFilterValues(NIGHT_FILTER_PRESET);
  } else {
    applyFilterValues(nightDaySnapshot ?? FILTER_DEFAULTS);
    nightDaySnapshot = null;
  }
}

nightModeToggle.addEventListener("change", () => {
  applyNightMode(nightModeToggle.checked);
  saveCameraState();
  // Fokus von der Checkbox nehmen, damit die Tastatursteuerung nicht hängt.
  nightModeToggle.blur();
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
    // Direkt über die Geocoding API mit dem Key des Spielers (siehe geocode.js).
    const data = await fetchGeocode(query);

    if (data.status !== "OK") {
      searchStatusEl.textContent =
        `Kein Ergebnis gefunden (${data.status}).` +
        (data.error ? ` ${data.error}` : "");
      searchPanel.classList.remove("searching"); // erneute Eingabe erlauben
      return;
    }

    const { lat, lng } = data;
    searchStatusEl.textContent = `Gefunden: ${data.formatted_address}`;

    // Sehenswürdigkeits-Hinweis ausblenden, bis der neue Ort geladen ist.
    discovery.setSuspended(true);

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

    setCruiseVelocity(125 / 3.6); // 125 km/h in m/s, damit man nach der Suche direkt weiterfliegt
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
    // Mit Controller (Drohnen-Ansicht) wieder in die nach vorne geneigte
    // Startlage, sonst zeigt die Kamera nach dem Sprung gen Himmel.
    if (isDroneView()) applyDroneStartPitch();
    if (isPaused) togglePause();
    discovery.setSuspended(false);
  } catch (err) {
    console.error(err);
    discovery.setSuspended(false);
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
let isRandomSpotFlightActive = false;

async function flyToRandomSpot() {
  // Doppelauslösung verhindern (z.B. R mehrfach gedrückt, solange der
  // Anflug bzw. das Kachel-Laden noch läuft).
  if (isRandomSpotFlightActive) return;
  isRandomSpotFlightActive = true;

  try {
    // Im laufenden Flug zuerst ins Pausenmenü wechseln, damit Status-Texte
    // ("Suche…", "Gefunden: …", "Lade Kacheln…") und Ladeanzeige exakt wie
    // beim Klick auf den Button erscheinen. geocodeAndFlyTo() setzt den Flug
    // am Ende selbst wieder fort (togglePause).
    if (!isPaused) togglePause();

    const query = pickRandomSpotQuery();
    searchInput.value = query;
    await geocodeAndFlyTo(query);
  } finally {
    isRandomSpotFlightActive = false;
  }
}

randomSpotButton.addEventListener("click", flyToRandomSpot);

// R: zufälligen Ort aus der 3D-Spots-Liste anfliegen - im Flug und im
// Pausenmenü. Mit Strg/Cmd/Alt ignorieren, damit z.B. Strg+R (Reload) nicht
// versehentlich einen Sprung auslöst.
window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyR" || e.repeat) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingInFormField(e.target)) return;
  if (controlsPanel.classList.contains("visible")) return;
  e.preventDefault();
  flyToRandomSpot();
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
    speed: Cesium.Cartesian3.magnitude(velocity),
    fovDegrees: Cesium.Math.toDegrees(viewer.camera.frustum.fov),
    cameraTiltDegrees: Cesium.Math.toDegrees(cameraTiltOffset),
    minimapLabelsVisible,
    planeVisible,
    contrastPct: colorGradeSettings.contrastAmount * 100,
    saturationPct: colorGradeSettings.saturationAmount * 100,
    brightnessPct: colorGradeSettings.brightnessAmount * 100,
    sepiaPct: colorGradeSettings.sepiaAmount * 100,
    tintPct: colorGradeSettings.tintAmount * 100,
    vignettePct: colorGradeSettings.vignetteAmount * 100,
    grainPct: (colorGradeSettings.grainAmount / GRAIN_MAX_INTENSITY) * 100,
    blurPct: colorGradeSettings.blurAmount * 100,
    nightMode,
    horizonGlowEnabled,
    nightDaySnapshot,
    starBrightnessPct: colorGradeSettings.starBrightness * 100,
    moonAzimuthDeg: Cesium.Math.toDegrees(moonAzimuthRad),
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
  // Sehenswürdigkeits-Hinweis ausblenden, bis der neue Ort geladen ist.
  discovery.setSuspended(true);
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

    setCruiseVelocity(favorite.speed);
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
    // Ältere Favoriten kennen keinen Blaustich/Nacht-Modus -> Tagwerte.
    applyTint(
      Number.isFinite(favorite.tintPct) ? favorite.tintPct : TINT_DEFAULT_PCT,
    );
    if (Number.isFinite(favorite.vignettePct))
      applyVignette(favorite.vignettePct);
    if (Number.isFinite(favorite.grainPct)) applyGrain(favorite.grainPct);
    if (Number.isFinite(favorite.blurPct)) applyBlur(favorite.blurPct);
    if (Number.isFinite(favorite.starBrightnessPct))
      applyStarBrightness(favorite.starBrightnessPct);
    if (Number.isFinite(favorite.moonAzimuthDeg))
      moonAzimuthRad = Cesium.Math.toRadians(favorite.moonAzimuthDeg);
    nightDaySnapshot = favorite.nightDaySnapshot ?? null;
    // Die gespeicherten Filterwerte gelten schon - nicht erneut preseten.
    applyNightMode(favorite.nightMode === true, { applyFilters: false });
    applyHorizonGlowEnabled(favorite.horizonGlowEnabled !== false);
    saveCameraState();

    if (isPaused) togglePause();
    discovery.setSuspended(false);
  } catch (err) {
    console.error(err);
    discovery.setSuspended(false);
    searchStatusEl.textContent = "Fehler beim Anfliegen des Favoriten.";
    searchPanel.classList.remove("searching");
  }
}

// --- Aktueller Ort (Reverse Geocoding, nur im Pausenmodus) --------------
// Nutzt dasselbe Geocoding (geocode.js) wie die Ortssuche, hier mit dem
// latlng-Parameter statt q.
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
    const data = await geocode({ latlng: `${lat},${lon}` });
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
  isViewPaused = false; // Menü übernimmt, Ruhe-Pause endet
  pressedKeys.clear();
  randomSpotButton.hidden = !isPaused;
  document.body.classList.toggle("pause-mode", isPaused);
  setSettingsMenuOpen(false);

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

// P: Ruhe-Pause an/aus - Flug einfrieren ohne Menü (Landschaft ansehen).
window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyP" || e.repeat) return;
  if (isTypingInFormField(e.target)) return;
  if (isPaused || controlsPanel.classList.contains("visible")) return;
  e.preventDefault();
  isViewPaused = !isViewPaused;
  pressedKeys.clear();
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

const MAX_SPEED = 120; // m/s, Sicherheits-Cap für den Geschwindigkeits-Betrag, entspricht ca. 430 km/h

// --- Schwerkraft/Schub-Modell --------------------------------------------
// Ersetzt das bisherige "Geschwindigkeit folgt exakt der Blickrichtung"-
// Modell durch echten Vektor-Flug: der Schub wirkt entlang der Drohnen-
// "Oben"-Achse (bodyUp, siehe Tick-Handler unten), die Schwerkraft immer
// lokal nach unten (Ellipsoid-Normale an der Kameraposition - nicht Welt-Z,
// sonst stimmt die Richtung nur am Äquator). Kippt die Nase nach vorne
// (Pitch), kippt bodyUp mit nach vorne und ein Teil des Schubs wird
// horizontal - genau der "Pitch + Throttle erzeugt Vorwärtsschub"-Effekt
// einer echten Acro-Drohne. Ohne Gas bleibt nur die Schwerkraft übrig, die
// Drohne sinkt gerade nach unten (durch Luftwiderstand gebremst, aber ohne
// Rückwärtsschub - siehe Gas-Logik im Tick-Handler).
const GRAVITY_ACCEL = 15; // m/s^2
const THRUST_TO_WEIGHT = 12; // Schub bei Vollgas relativ zur Schwerkraft-Beschleunigung - sportliches Acro-Setup
// (Ursprünglich 1.5 gewählt, war aber zu knapp: die "Rückhol-Kraft" aus
// einem Sturzflug hängt vom ABSTAND zwischen aktueller Geschwindigkeit und
// der neuen Vollgas-Gleichgewichtsgeschwindigkeit ab - bei 1.5 lagen beide
// zu nah beieinander, der Übergang dauerte dadurch mehrere Sekunden statt
// unter einer Sekunde wie bei einer echten Drohne.)
const THRUST_MAX_ACCEL = THRUST_TO_WEIGHT * GRAVITY_ACCEL; // m/s^2 bei Vollgas
const HOVER_THROTTLE = 1 / THRUST_TO_WEIGHT; // Gasstellung, bei der Schub = Schwerkraft (Schweben in Level-Fluglage)
const THROTTLE_RAMP_TIME = 0.1; // Sekunden, um bei gehaltenem W/S von 0 auf 1 (bzw. zurück) zu gasen
// (Weiter verkürzt - soll sich wie ein knackiger Stick-Ausschlag anfühlen,
// nicht wie eine spürbare Rampe.)
const TERMINAL_FALL_SPEED = 39.24; // m/s (≈ 141 km/h) - Sink-Endgeschwindigkeit im freien Fall, wie zuvor mit dem linearen Modell
// Quadratischer statt linearer Luftwiderstand (wie echter aerodynamischer
// Widerstand: proportional zu v², nicht zu v). Der Unterschied ist bei
// niedrigem Tempo entscheidend: dort ist die Bremswirkung fast null, der
// volle Schub/Schwerkraft-Unterschied wirkt fast ungebremst - genau der
// Moment, in dem man einen Sturzflug abfängt (Nulldurchgang der
// Geschwindigkeit). Das lineare Modell bremste dort genauso stark wie bei
// hohem Tempo, was sich "driftig"/träge anfühlte. Erst nahe der
// Grenzgeschwindigkeit wird der Widerstand spürbar und begrenzt Sink-/
// Höchstgeschwindigkeit - dafür aus TERMINAL_FALL_SPEED zurückgerechnet.
const DRAG_COEFF_QUAD =
  GRAVITY_ACCEL / (TERMINAL_FALL_SPEED * TERMINAL_FALL_SPEED);

// Setzt eine reine Vorwärts-Geschwindigkeit entlang der aktuellen
// Blickrichtung (z.B. nach einem Orts-Sprung, damit man nicht stehend
// startet) und die Gasstellung auf HOVER_THROTTLE, damit die Drohne in
// Level-Fluglage weder steigt noch fällt, bis der Spieler selbst gast.
function setCruiseVelocity(speedMps) {
  velocity = Cesium.Cartesian3.multiplyByScalar(
    viewer.camera.direction,
    speedMps,
    new Cesium.Cartesian3(),
  );
  throttle = HOVER_THROTTLE;
}

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

// Normiert einen Winkel (rad) auf (-PI, PI] - wird für die Controller-
// Achsen gebraucht, deren Winkel beim Fliegen von Loopings/Rolls beliebig
// weit über die Vollkreis-Grenze hinauswachsen. sin()/cos() (u.a. in
// Cesiums camera.setView) sind ohnehin periodisch, daher ändert das
// Wrapping nichts am tatsächlichen Flugverhalten - es verhindert nur, dass
// die Zahl über eine lange Flugsession unbegrenzt weiterwächst.
function wrapAngle(angle) {
  return angle - Math.PI * 2 * Math.floor((angle + Math.PI) / (Math.PI * 2));
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
const COLLISION_BRAKE_DECEL = 200; // m/s^2 - deutlich stärker als THRUST_MAX_ACCEL, aber kein harter Ruck

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

let velocity = new Cesium.Cartesian3(0, 0, 0); // aktuelle Geschwindigkeit, Weltkoordinaten (m/s) - siehe Schwerkraft/Schub-Modell oben
// Tastatur-Flug (kein Controller): eingestellte Fluggeschwindigkeit in m/s.
// W = schneller, S = langsamer/bremsen, ohne Taste bleibt sie erhalten.
let keyboardSpeed = 0;
const KEYBOARD_SPEED_ACCEL = 40; // m/s^2 bei gehaltenem W/S
let wasKeyboardFlight = false;
let throttle = 0; // 0..1, aktuelle Gasstellung (kein Rückwärtsschub - siehe Tick-Handler)
// Eigener Heading-Zustand der Flugsteuerung. camera.heading darf NICHT jeden
// Frame zurückgelesen werden: Cesium schaltet bei fast senkrechtem Blick
// (|direction.z| > 0.999 im lokalen Frame) auf eine andere Formel um, die den
// Roll mit einrechnet - das addiert pro Frame einen Fehler auf den Heading
// und erzeugt die schnelle Spirale beim Blick nach unten.
let flightHeading = 0;
let lastAppliedDirection = null; // Kameraausrichtung am Ende des letzten Ticks
let lastAppliedUp = null; // (um externe Änderungen wie Ortssprung/Favoriten zu erkennen)
let pitch = 0; // angezeigter/tatsächlich geflogener Wert, immer = softLimitAngle(pitchRaw, ...)
let pitchRaw = 0; // ungekappter interner Akkumulator, siehe softLimitAngle oben
let roll = 0; // angezeigter/tatsächlich geflogener Wert, immer = softLimitAngle(rollRaw, ...)
let rollRaw = 0; // ungekappter interner Akkumulator, siehe softLimitAngle oben
// Merkt sich pro Achse, welche Eingabequelle zuletzt aktiv war ("keyboard"
// oder "controller") - wird gebraucht, damit z.B. nach dem Loslassen einer
// Taste die Tastatur-Rückkehr-Zeitkonstante weiterläuft (statt sofort auf
// die Controller-Glättung umzuspringen), obwohl der Zielwert in dem Moment
// bei beiden Quellen 0 ist. Startwert "keyboard", damit sich ohne
// angeschlossenen Controller exakt das bisherige Verhalten ergibt.
let pitchControlSource = "keyboard";
let rollControlSource = "keyboard";
let yawControlSource = "keyboard";
let rollLevelBlend = 0; // 0..1, sanftes Ein-/Ausblenden des Auto-Level-Zugs (siehe ROLL_LEVEL_BLEND_TIME)
let pitchRate = 0; // aktuelle (geglättete) Pitch-Änderungsrate
let rollRate = 0; // aktuelle (geglättete) Roll-Änderungsrate
let yawRate = 0; // aktuelle (geglättete) Seitenruder-Rate
let wasColliding = false; // für Flankenerkennung: Flash nur beim Kollisionsbeginn auslösen

const pressedKeys = new Set();
window.addEventListener("keydown", (e) => {
  if (!isPaused && !isViewPaused) pressedKeys.add(e.code);
});
window.addEventListener("keyup", (e) => pressedKeys.delete(e.code));
window.addEventListener("blur", () => pressedKeys.clear());

// --- Gamepad/Controller-Steuerung (z.B. TBS Tango 2 im USB-Joystick/HID-
// Modus) ------------------------------------------------------------------
// Ergänzt die Tastatursteuerung um eine alternative Eingabe per physischem
// FPV-Controller, ohne den bestehenden Tastatur-Code oben anzufassen: Die
// Tastatur-Ziele (pressedKeys, getPitchTarget/getRollTarget) bleiben exakt
// wie zuvor und haben unten in der Update-Schleife immer Vorrang - der
// Controller wird pro Achse nur dann genutzt, wenn die Tastatur für diese
// Achse gerade kein Ziel liefert. So kann man jederzeit zwischen beiden
// Eingabemethoden wechseln, ohne etwas umschalten zu müssen.
const CONTROLLER_DEADZONE = 0.05; // Achsen-Ausschlag unterhalb dieses Betrags gilt als "Mitte"/kein Eingang

// Achsen-Zuordnung für den TBS Tango 2 im HID-Modus, per Debug-Overlay
// ermittelt (weicht von der ursprünglichen Mode-2-Annahme ab):
// Achse 0 = Gas, Achse 1 = Rollen, Achse 2 = Pitch, Achse 3 = Gieren.
const CONTROLLER_AXIS = {
  throttle: { index: 0, invert: false },
  roll: { index: 1, invert: false },
  pitch: { index: 2, invert: true }, // konsistent zur Tastatur-Invertierung oben (ArrowUp = Nase runter)
  yaw: { index: 3, invert: false },
};

// Eigenständige Controller-Tuning-Werte, komplett getrennt von den
// Tastatur-Konstanten oben (PITCH_RATE, ROLL_RATE, RUDDER_YAW_RATE, alle
// SMOOTH_TIME-Werte, softLimitAngle/PITCH_LIMIT_EASE_DEG etc.). Der
// Controller läuft NICHT durch die Tastatur-Pipeline (Rate-Rampe +
// Soft-Limit-Kompression + Attitude-Winkel-Limit), sondern als echtes
// Acro-/Rate-Modell wie bei einer FPV-Drohne: Stick-Ausschlag = direkte
// Rotationsrate ohne jede Glättung/Verzögerung, Winkel sind unbegrenzt
// (Loopings/Rolls möglich) statt auf ein Attitude-Maximum begrenzt. Das
// hält beide Steuerungsarten unabhängig voneinander einstellbar:
// Tastatur-Feintuning wirkt sich nie auf den Controller aus und umgekehrt.
// Rates im Betaflight-"Actual"-Stil pro Achse:
//   center = Empfindlichkeit um die Stick-Mitte (°/s bei linearem Verlauf),
//   max    = Maximalrate bei Vollausschlag (°/s),
//   expo   = 0..1, höher = feiner um die Mitte, steiler zum Anschlag.
const CONTROLLER_RATES = {
  pitch: { center: 200, max: 500, expo: 0.575 },
  roll: { center: 200, max: 500, expo: 0.575 },
  yaw: { center: 200, max: 450, expo: 0.525 },
};

// Stick (-1..1, nach Deadzone) -> Drehrate in rad/s.
// Formel wie Betaflight "Actual Rates": x*center + (max-center)*|x|*(x^5*expo + x*(1-expo))
function controllerRate(x, rates) {
  const abs = Math.abs(x);
  const curve = abs * (Math.pow(x, 5) * rates.expo + x * (1 - rates.expo));
  const stickMovement = Math.max(0, rates.max - rates.center);
  return Cesium.Math.toRadians(x * rates.center + stickMovement * curve);
}

// --- Gimbal-freie Acro-Rotation (schräger Looping etc.) -------------------
// Bug: Wenn Pitch UND Roll gleichzeitig vom Controller kommen (z.B.
// schräger Looping = rechter Stick diagonal), wurde die Kamera-Ausrichtung
// bisher jeden Frame neu aus den drei UNABHÄNGIG akkumulierten Skalaren
// heading/pitch/roll per camera.setView({heading, pitch, roll})
// zusammengesetzt. Das ist eine Euler-Winkel-Komposition und hat nahe
// Pitch=±90° eine Gimbal-Singularität: Roll- und Heading-Achse fallen dort
// (fast) zusammen, wodurch der Pitch-Eingang kurzzeitig gespiegelt
// ankommt/man "rückwärts" zu fliegen scheint - bis der Winkel durch den
// kritischen Bereich durch ist (daher "nach Wiederholen wieder normal").
// Reiner Pitch- oder reiner Roll-Looping (nur eine Achse aktiv) läuft zwar
// auch durch Pitch=90°, bleibt aber unauffällig, weil dabei keine zweite
// Achse mitrotiert, die von der Singularität verfälscht werden könnte.
// Fix NUR für reines Acro-Fliegen (Pitch+Roll+Gier alle vom Controller):
// die Kamera-Achsen (direction/up) werden nicht mehr aus Winkeln neu
// zusammengesetzt, sondern direkt um die eigenen Körperachsen weiter-
// rotiert (Rodrigues-Formel) - das hat keine Singularität, unabhängig vom
// Flugmanöver. Tastatur-Flug bleibt unangetastet (dort sind Pitch/Roll auf
// ±45°/±30° begrenzt, die Singularität wird nie erreicht).
const acroRotScratchRight = new Cesium.Cartesian3();
const acroRotScratchAxis = new Cesium.Cartesian3();
const acroRotScratchQuat = new Cesium.Quaternion();
const acroRotScratchMatrix = new Cesium.Matrix3();
// Eigene Fluglage des Acro-Pfads (direction/up OHNE kosmetischen Kamera-Tilt).
// Wichtig: Der Tilt wird pro Frame nur auf KOPIEN angewandt. Würde man die
// Fluglage aus camera.direction/up zurücklesen, wäre der Tilt vom letzten
// Frame schon enthalten und würde sich jeden Frame erneut aufaddieren
// (45° pro Frame -> Kamera taumelt/springt).
const acroFlightDirection = new Cesium.Cartesian3();
const acroFlightUp = new Cesium.Cartesian3();
const acroTiltScratchDirection = new Cesium.Cartesian3();
const acroTiltScratchUp = new Cesium.Cartesian3();
let acroFlightValid = false;
// Gieren (yawRate) dreht um yawAxis = Körper-Hochachse der Drohne (wie die
// Flight Control einer echten FPV-Drohne, die nicht weiß, wo "oben" auf der
// Erde ist) - die Bildschirm-Richtung bleibt dadurch in jeder Fluglage gleich,
// auch im Rückenflug. Rollen dreht um die Flugrichtung, Pitch um die
// Körper-Rechts-Achse.
// Test-Regler: Wie stark die Roll-Achse vom Körper-Vorwärtsvektor (0 = wie bei
// einer echten Drohne mit starrer Kamera, Roll wirkt bei Kamera-Tilt auf dem
// Bild auch als Gieren) zur Blickachse (1 = reines Bild-Rollen) wandert.
// Zur Laufzeit in der Browser-Konsole änderbar: setAcroRollBlend(0.5)
let acroRollAxisBlend = 0.75;
window.setAcroRollBlend = (v) => {
  acroRollAxisBlend = Cesium.Math.clamp(Number(v), 0, 1);
  return acroRollAxisBlend;
};
// Setzt die Kamera-Lage direkt aus direction/up (Welt-Koordinaten), OHNE den
// Umweg über Heading/Pitch/Roll: camera.setView({direction, up}) rechnet
// intern in Euler-Winkel um und wieder zurück - nahe Pitch = ±90° (mitten im
// Looping) ist das numerisch ungenau (Gimbal) und erzeugte kleine Ruckler,
// teils sogar Fehlalarme der "Kamera von außen geändert"-Erkennung.
function setCameraPoseDirect(camera, position, direction, up) {
  if (!Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY)) {
    camera.setView({ destination: position, orientation: { direction, up } });
    return;
  }
  Cesium.Cartesian3.clone(position, camera.position);
  Cesium.Cartesian3.clone(direction, camera.direction);
  Cesium.Cartesian3.clone(up, camera.up);
  Cesium.Cartesian3.cross(camera.direction, camera.up, camera.right);
}
const acroRollAxisScratch = new Cesium.Cartesian3();
const acroRollAxisUpScratch = new Cesium.Cartesian3();
function rotateAroundBodyAxes(direction, up, rollRate, pitchRate, yawRate, yawAxis, dt, rollAxisTilt = 0) {
  const right = Cesium.Cartesian3.cross(direction, up, acroRotScratchRight);
  // Roll-Achse = tatsächliche BLICKrichtung (Körper-Vorwärtsachse inkl.
  // kosmetischem Kamera-Tilt). Würde man um die reine Körper-Vorwärtsachse
  // rollen, während die Kamera nach oben geneigt ist (FPV-Tilt), sähe das auf
  // dem Bildschirm wie Roll + Gieren aus, weil die Roll-Achse dann schräg zur
  // Blickachse steht. Mit der Blickachse dreht sich das Bild rein um die
  // Bildmitte (reines Rollen).
  const rollAxis = Cesium.Cartesian3.clone(direction, acroRollAxisScratch);
  if (rollAxisTilt !== 0) {
    applyRenderTiltToAxes(
      rollAxis,
      Cesium.Cartesian3.clone(up, acroRollAxisUpScratch),
      rollAxisTilt,
    );
  }
  // Winkelgeschwindigkeits-Vektor (Rollen um Blickachse, Pitch um right,
  // Gieren um die lokale Senkrechte) zu einem Weltachsen-Vektor kombiniert.
  const axis = acroRotScratchAxis;
  axis.x = rollAxis.x * rollRate + right.x * pitchRate + yawAxis.x * yawRate;
  axis.y = rollAxis.y * rollRate + right.y * pitchRate + yawAxis.y * yawRate;
  axis.z = rollAxis.z * rollRate + right.z * pitchRate + yawAxis.z * yawRate;
  const angle = Cesium.Cartesian3.magnitude(axis) * dt;
  if (angle === 0) return;
  Cesium.Cartesian3.normalize(axis, axis);
  const rot = Cesium.Matrix3.fromQuaternion(
    Cesium.Quaternion.fromAxisAngle(axis, angle, acroRotScratchQuat),
    acroRotScratchMatrix,
  );
  Cesium.Matrix3.multiplyByVector(rot, direction, direction);
  Cesium.Matrix3.multiplyByVector(rot, up, up);
  // Gegen schleichenden Float-Drift: direction/up wieder orthonormalisieren.
  Cesium.Cartesian3.normalize(direction, direction);
  const d = Cesium.Cartesian3.dot(direction, up);
  up.x -= direction.x * d;
  up.y -= direction.y * d;
  up.z -= direction.z * d;
  Cesium.Cartesian3.normalize(up, up);
}
// Dieselbe Rodrigues-Rotation, nur für den kosmetischen Kamera-Tilt
// (cameraTiltOffset) - rotiert um die (schon geflogene) eigene Rechts-Achse,
// statt den Tilt per Euler auf heading/pitch/roll draufzurechnen.
const tiltRotScratchRight = new Cesium.Cartesian3();
const tiltRotScratchQuat = new Cesium.Quaternion();
const tiltRotScratchMatrix = new Cesium.Matrix3();
function applyRenderTiltToAxes(direction, up, angle) {
  if (angle === 0) return;
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(direction, up, tiltRotScratchRight),
    tiltRotScratchRight,
  );
  const rot = Cesium.Matrix3.fromQuaternion(
    Cesium.Quaternion.fromAxisAngle(right, angle, tiltRotScratchQuat),
    tiltRotScratchMatrix,
  );
  Cesium.Matrix3.multiplyByVector(rot, direction, direction);
  Cesium.Matrix3.multiplyByVector(rot, up, up);
}

const controllerDebugEl = document.getElementById("controller-debug");

// Startlage für die Drohnen-/FPV-Ansicht: Die Kamera ist um cameraTiltOffset
// nach oben geneigt (wie bei einer echten FPV-Drohne). Bei pitch = 0 würde
// die Ansicht dadurch direkt zum Himmel zeigen (und der Schub senkrecht
// nach oben gehen). Deshalb wird die Drohne hier um genau diesen Winkel
// nach vorne geneigt - Rendering-Pitch (pitch + Tilt) ergibt 0, man
// schaut also geradeaus zum Horizont und fliegt sofort nach vorne.
function applyDroneStartPitch() {
  pitch = wrapAngle(-cameraTiltOffset);
  pitchRaw = inverseSoftLimitAngle(
    pitch,
    PITCH_MAX,
    Cesium.Math.toRadians(PITCH_LIMIT_EASE_DEG),
  );
  pitchRate = 0;
  // Controller-Pfad hält den Winkel bei Stick-Mitte; der Tastatur-Pfad
  // würde ihn dagegen wieder Richtung 0 zurückführen.
  pitchControlSource = "controller";
}

window.addEventListener("gamepadconnected", (e) => {
  connectedGamepadIndex = e.gamepad.index;
  updateStickOverlay();
  // Debug-Overlay (Achsenwerte) bleibt bewusst dauerhaft ausgeblendet -
  // war nur fürs Controller-Tuning während der Entwicklung gedacht.
  updateHorizonVisibility();
  applyDroneViewDefaults();
  applyDroneStartPitch();
});
window.addEventListener("gamepaddisconnected", (e) => {
  if (connectedGamepadIndex === e.gamepad.index) {
    connectedGamepadIndex = null;
    updateStickOverlay();
    if (controllerDebugEl) controllerDebugEl.hidden = true;
    updateHorizonVisibility();
  }
});

// Skaliert den Ausschlag jenseits der Deadzone wieder auf den vollen
// -1..1-Bereich, statt die Deadzone einfach nur abzuschneiden - sonst
// bliebe direkt nach der Deadzone-Grenze ein toter Bereich ohne volle
// Auflösung bis zum Anschlag.
function applyDeadzone(value) {
  if (Math.abs(value) < CONTROLLER_DEADZONE) return 0;
  const sign = Math.sign(value);
  return (
    sign *
    ((Math.abs(value) - CONTROLLER_DEADZONE) / (1 - CONTROLLER_DEADZONE))
  );
}

function getControllerAxis(axisConfig) {
  if (connectedGamepadIndex === null) return 0;
  const gamepads = navigator.getGamepads();
  const gp = gamepads[connectedGamepadIndex];
  if (!gp || !gp.axes || gp.axes.length <= axisConfig.index) return 0;
  const raw = gp.axes[axisConfig.index];
  return applyDeadzone(axisConfig.invert ? -raw : raw);
}

function updateControllerDebugOverlay() {
  if (!controllerDebugEl || connectedGamepadIndex === null) return;
  const gp = navigator.getGamepads()[connectedGamepadIndex];
  if (!gp) return;
  const axesText = gp.axes
    .map((v, i) => `  Achse ${i}: ${v.toFixed(2)}`)
    .join("\n");
  const buttonsText = gp.buttons
    .map((b, i) => `  Button ${i}: ${b.pressed ? "AN" : "aus"} (${b.value.toFixed(2)})`)
    .join("\n");
  controllerDebugEl.textContent = `Controller: ${gp.id}\n${axesText}\n${buttonsText}`;
}

// --- Stick-Overlay ----------------------------------------------------------
// Zeigt beide Sticks als Punkt in einem Quadrat an, solange ein Controller
// verbunden und das Overlay aktiviert ist. Linker Stick: Gieren (x) / Gas (y), rechter Stick: Roll (x) /
// Pitch (y). Dargestellt wird die Stick-Stellung ohne Deadzone, aber mit der
// Achsen-Zuordnung/Invertierung aus CONTROLLER_AXIS. Positiv = rechts bzw. oben.
const stickOverlayEl = document.getElementById("stick-overlay");
const stickOverlayToggle = document.getElementById("stick-overlay-toggle");
stickOverlayToggle.addEventListener("change", updateStickOverlay);
const stickLeftDotEl = document.getElementById("stick-left-dot");
const stickRightDotEl = document.getElementById("stick-right-dot");
const STICK_DOT_TRAVEL_PX = 40; // maximaler Weg des Punkts von der Mitte (Feld 96px, Punkt 16px)

function getControllerAxisRaw(axisConfig, gp) {
  if (!gp || !gp.axes || gp.axes.length <= axisConfig.index) return 0;
  const raw = gp.axes[axisConfig.index];
  return Cesium.Math.clamp(axisConfig.invert ? -raw : raw, -1, 1);
}

function setStickDot(dotEl, x, y) {
  // y positiv = Stick nach oben -> Punkt nach oben (negative CSS-y)
  dotEl.style.transform = `translate3d(${x * STICK_DOT_TRAVEL_PX}px, ${-y * STICK_DOT_TRAVEL_PX}px, 0)`;
}

function updateStickOverlay() {
  if (!stickOverlayEl) return;
  const visible = stickOverlayToggle.checked && connectedGamepadIndex !== null;
  if (stickOverlayEl.hidden === visible) stickOverlayEl.hidden = !visible;
  if (!visible) return;
  const gp = navigator.getGamepads()[connectedGamepadIndex];
  if (!gp) return;
  setStickDot(
    stickLeftDotEl,
    getControllerAxisRaw(CONTROLLER_AXIS.yaw, gp),
    getControllerAxisRaw(CONTROLLER_AXIS.throttle, gp),
  );
  setStickDot(
    stickRightDotEl,
    getControllerAxisRaw(CONTROLLER_AXIS.roll, gp),
    -getControllerAxisRaw(CONTROLLER_AXIS.pitch, gp), // Pitch im Overlay invertiert
  );
}

// Controller-Schalter (Achse 6): Zwei-/Dreistufenschalter mit -1 / +1.
// +1 = "Stick-Overlay" und "Anzeigen | HUD" gemeinsam an, -1 = beide aus.
// Eine Mittelstellung (3-Stufen-Schalter) lässt den Zustand unverändert.
// Die Startstellung wird nur gemerkt, nicht als Umschaltung gewertet.
// Soll die Richtung umgekehrt sein: SCREEN_UI_AXIS_ON_SIGN auf -1 setzen.
const SCREEN_UI_TOGGLE_AXIS = 6;
const SCREEN_UI_AXIS_ON_SIGN = 1;
let screenUiAxisActive = null;

function pollScreenUiAxis() {
  if (connectedGamepadIndex === null) {
    screenUiAxisActive = null; // beim erneuten Verbinden neu einlesen
    return;
  }
  const gp = navigator.getGamepads()[connectedGamepadIndex];
  if (!gp || !gp.axes || gp.axes.length <= SCREEN_UI_TOGGLE_AXIS) return;
  const v = gp.axes[SCREEN_UI_TOGGLE_AXIS] * SCREEN_UI_AXIS_ON_SIGN;
  let active = screenUiAxisActive;
  if (v > 0.5) active = true;
  else if (v < -0.5) active = false;
  if (active === null) return; // Mittelstellung beim ersten Auslesen
  if (screenUiAxisActive !== null && active !== screenUiAxisActive) {
    stickOverlayToggle.checked = active;
    updateStickOverlay();
    applyHudHidden(!active);
    saveCameraState();
  }
  screenUiAxisActive = active;
}

// Controller-Knöpfe (TBS Tango 2, hinten): E = Button 0, F = Button 1.
// E = vorherige, F = nächste Sehenswürdigkeit (wie Taste Z / X). Ausgelöst
// wird nur beim Drücken (steigende Flanke), nicht beim Halten.
const CONTROLLER_BUTTON_PREV_SPOT = 0; // E
const CONTROLLER_BUTTON_NEXT_SPOT = 1; // F
let lastControllerButtons = null;

function pollControllerButtons() {
  if (connectedGamepadIndex === null) {
    lastControllerButtons = null; // beim erneuten Verbinden neu einlesen
    return;
  }
  const gp = navigator.getGamepads()[connectedGamepadIndex];
  if (!gp || !gp.buttons) return;
  const pressed = gp.buttons.map((b) => b.pressed);
  if (lastControllerButtons !== null && !controlsPanel.classList.contains("visible")) {
    const justPressed = (i) => pressed[i] && !lastControllerButtons[i];
    if (justPressed(CONTROLLER_BUTTON_PREV_SPOT)) discovery.cycleTarget(-1);
    if (justPressed(CONTROLLER_BUTTON_NEXT_SPOT)) discovery.cycleTarget(1);
  }
  lastControllerButtons = pressed;
}

// Controller-Schalter (Achse 5): Pause und zufälliger Ort.
// -1 = Ruhe-Pause (wie Taste P) solange der Schalter unten steht, beim
// Verlassen läuft der Flug weiter. +1 = zufälligen Ort anfliegen (wie Taste R),
// einmal beim Umlegen. Mittelstellung = nichts. Die Startstellung wird nur
// gemerkt. Bei geöffnetem Pausenmenü wird der Schalter ignoriert.
const FLIGHT_SWITCH_AXIS = 5;
let flightSwitchPos = null;

function pollFlightSwitchAxis() {
  if (connectedGamepadIndex === null) {
    flightSwitchPos = null; // beim erneuten Verbinden neu einlesen
    return;
  }
  const gp = navigator.getGamepads()[connectedGamepadIndex];
  if (!gp || !gp.axes || gp.axes.length <= FLIGHT_SWITCH_AXIS) return;
  const v = gp.axes[FLIGHT_SWITCH_AXIS];
  const pos = v > 0.5 ? 1 : v < -0.5 ? -1 : 0;
  if (flightSwitchPos === null) {
    flightSwitchPos = pos;
    return;
  }
  if (pos === flightSwitchPos) return;
  const prev = flightSwitchPos;
  flightSwitchPos = pos;
  if (isPaused || controlsPanel.classList.contains("visible")) return;
  if (pos === -1) {
    isViewPaused = true;
    pressedKeys.clear();
  } else if (prev === -1) {
    isViewPaused = false;
    pressedKeys.clear();
  }
  if (pos === 1) flyToRandomSpot();
}

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

  // Muss vor dem Pause-Return laufen, sonst kann der Schalter die Ruhe-Pause nicht beenden.
  pollFlightSwitchAxis();

  // Pausiert: keine Bewegung/Steuerungsänderung, Frame einfach überspringen
  // (lastTime wurde oben schon aktualisiert, damit es beim Fortsetzen keinen dt-Sprung gibt)
  if (isPaused || isViewPaused) {
    updateFlightAudio({ throttle, droneEnabled: false, enabled: false });
    return;
  }

  const camera = viewer.camera;

  // Gas: W erhöht, S verringert die Gasstellung (0..1) - ohne Tastendruck
  // bleibt der aktuelle Wert einfach erhalten (kein Federrückstellung, wie
  // bei einem echten Acro-Gasstick). Kein Rückwärtsschub: S kann die
  // Gasstellung nur bis 0 zurücknehmen - danach übernimmt allein die
  // Schwerkraft (siehe unten), Bremsen/Sinken passiert dann rein
  // physikalisch statt über Reverse-Thrust.
  const keyboardFlight = !isDroneView();
  if (keyboardFlight) {
    // Beim Wechsel in den Tastatur-Flug die aktuelle Geschwindigkeit übernehmen.
    if (!wasKeyboardFlight) {
      keyboardSpeed = Math.min(Cesium.Cartesian3.magnitude(velocity), MAX_SPEED);
    }
    if (pressedKeys.has("KeyW")) {
      keyboardSpeed = Math.min(keyboardSpeed + KEYBOARD_SPEED_ACCEL * dt, MAX_SPEED);
    } else if (pressedKeys.has("KeyS")) {
      keyboardSpeed = Math.max(keyboardSpeed - KEYBOARD_SPEED_ACCEL * dt, 0);
    }
  } else if (pressedKeys.has("KeyW")) {
    throttle = Math.min(throttle + dt / THROTTLE_RAMP_TIME, 1);
  } else if (pressedKeys.has("KeyS")) {
    throttle = Math.max(throttle - dt / THROTTLE_RAMP_TIME, 0);
  } else if (connectedGamepadIndex !== null) {
    // Controller-Gas wirkt absolut (Stick-Position = Ziel-Gasstellung),
    // nicht wie W/S über eine Rampe - das entspricht dem Gas-Stick eines
    // echten FPV-Senders ohne Federrückstellung. Negativer Ausschlag wird
    // auf 0 gekappt (kein Rückwärtsschub, siehe Kommentar oben).
    const throttleAxis = getControllerAxis(CONTROLLER_AXIS.throttle);
    throttle = Cesium.Math.clamp(throttleAxis, 0, 1);
  }

  // Pitch: TESTWEISE INVERTIERT - Pfeil hoch = Nase runter, Pfeil runter =
  // Nase hoch. Die Rate wird weiterhin sanft an-/abgebremst, der Winkel
  // bleibt stehen, wenn keine Taste gedrückt ist. getPitchTarget toleriert
  // kurze Tasten-Lücken beim Richtungswechsel (siehe createAxisTargetTracker
  // oben).
  const pitchTargetKeyboard = getPitchTarget(now);
  const pitchTargetGamepad = getControllerAxis(CONTROLLER_AXIS.pitch);
  if (pitchTargetKeyboard !== 0) {
    pitchControlSource = "keyboard";
  } else if (pitchTargetGamepad !== 0) {
    pitchControlSource = "controller";
  }

  if (pitchControlSource === "controller") {
    // CONTROLLER-PFAD: reines Acro-/Rate-Modell wie bei einer FPV-Drohne -
    // Stick-Ausschlag = Rotationsrate, 1:1 ohne Glättung/Verzögerung, Winkel
    // wächst unbegrenzt (Loopings möglich) statt auf PITCH_MAX gedeckelt zu
    // werden. Komplett unabhängig von der Tastatur-Pipeline unten.
    const pitchRateGamepad = controllerRate(pitchTargetGamepad, CONTROLLER_RATES.pitch);
    pitch = wrapAngle(pitch + pitchRateGamepad * dt);
    pitchRate = 0;
    // pitchRaw synchron halten, damit bei Rückwechsel auf Tastatur kein
    // Sprung entsteht (softLimitAngle deckelt das automatisch wieder auf
    // den Tastatur-Bereich, falls der Winkel gerade z.B. mitten in einem
    // Looping steht).
    pitchRaw = inverseSoftLimitAngle(
      pitch,
      PITCH_MAX,
      Cesium.Math.toRadians(PITCH_LIMIT_EASE_DEG),
    );
  } else {
    // TASTATUR-PFAD (unverändert) - nur PITCH_RATE/PITCH_SMOOTH_TIME/
    // PITCH_RETURN_SMOOTH_TIME/PITCH_LIMIT_EASE_DEG gelten hier, niemals
    // Controller-Werte.
    const pitchTarget = pitchTargetKeyboard;
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
  const rollTargetKeyboard = getRollTarget(now);
  const rollTargetGamepad = getControllerAxis(CONTROLLER_AXIS.roll);
  if (rollTargetKeyboard !== 0) {
    rollControlSource = "keyboard";
  } else if (rollTargetGamepad !== 0) {
    rollControlSource = "controller";
  }

  if (rollControlSource === "controller") {
    // CONTROLLER-PFAD: reines Acro-/Rate-Modell wie bei einer FPV-Drohne -
    // Stick-Ausschlag = Rotationsrate, 1:1 ohne Glättung/Verzögerung, Winkel
    // wächst unbegrenzt (volle Rolls möglich) statt auf ROLL_MAX gedeckelt
    // zu werden. Kein Auto-Level nötig/gewünscht - das ist reines
    // Tastatur-Feintuning für den Attitude-Modus.
    const rollRateGamepad = controllerRate(rollTargetGamepad, CONTROLLER_RATES.roll);
    roll = wrapAngle(roll + rollRateGamepad * dt);
    rollRate = 0;
    rollLevelBlend = 0;
    // rollRaw synchron halten, damit bei Rückwechsel auf Tastatur kein
    // Sprung entsteht (softLimitAngle deckelt automatisch wieder auf den
    // Tastatur-Bereich).
    rollRaw = inverseSoftLimitAngle(
      roll,
      ROLL_MAX,
      Cesium.Math.toRadians(ROLL_LIMIT_EASE_DEG),
    );
  } else {
    // TASTATUR-PFAD (unverändert) - nur ROLL_RATE/ROLL_SMOOTH_TIME/
    // ROLL_RETURN_SMOOTH_TIME/ROLL_AUTO_LEVEL_TIME/ROLL_LIMIT_EASE_DEG
    // gelten hier, niemals Controller-Werte.
    const rollTarget = rollTargetKeyboard;
    const rollHeld =
      pressedKeys.has("ArrowLeft") || pressedKeys.has("ArrowRight");
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
  }


  // Gieren (Heading): Seitenruder A/D (sanft geglättet wie Pitch) +
  // koordinierte Kurve durch Rollen (bleibt direkt an den Roll-Winkel gekoppelt).
  const yawTargetKeyboard = pressedKeys.has("KeyA")
    ? -RUDDER_YAW_RATE
    : pressedKeys.has("KeyD")
      ? RUDDER_YAW_RATE
      : 0;
  const yawTargetGamepad = controllerRate(getControllerAxis(CONTROLLER_AXIS.yaw), CONTROLLER_RATES.yaw);
  if (yawTargetKeyboard !== 0) {
    yawControlSource = "keyboard";
  } else if (yawTargetGamepad !== 0) {
    yawControlSource = "controller";
  }
  // Eigene Quelle pro Achse: Tastatur behält ihre Glättung (YAW_SMOOTH_TIME),
  // Controller reagiert instant/ohne Verzögerung (siehe CONTROLLER_RATES.yaw).
  const yawTarget =
    yawControlSource === "controller" ? yawTargetGamepad : yawTargetKeyboard;
  if (yawControlSource === "controller") {
    yawRate = yawTarget;
  } else {
    const yawSmoothing = 1 - Math.exp(-dt / YAW_SMOOTH_TIME);
    yawRate += (yawTarget - yawRate) * yawSmoothing;
  }

  // Heading aus eigenem Zustand fortschreiben. Nur wenn die Kamera seit dem
  // letzten Tick von außen verstellt wurde (Ortssprung, Favorit, Fortsetzen
  // nach Pause, erster Tick), wird er einmalig aus camera.heading neu
  // übernommen - siehe Kommentar bei flightHeading.
  const cameraChangedExternally =
    lastAppliedDirection === null ||
    !Cesium.Cartesian3.equalsEpsilon(camera.direction, lastAppliedDirection, 1e-6) ||
    !Cesium.Cartesian3.equalsEpsilon(camera.up, lastAppliedUp, 1e-6);
  if (cameraChangedExternally) flightHeading = camera.heading;
  let heading = flightHeading;
  heading += yawRate * dt;
  // Koordinierte Kurve durch Rollen ist ein Tastatur-Attitude-Konzept
  // (kleine Schräglage erzeugt einen realistischen Kurvenzug) - beim
  // Controller-Acro-Modell mit unbegrenztem Rollwinkel (z.B. mitten in
  // einer vollen Rolle) ergäbe dieselbe Formel keinen sinnvollen
  // Kurvenzug mehr, daher gilt sie nur, solange Roll gerade von der
  // Tastatur kommt.
  if (rollControlSource !== "controller") {
    heading += roll * ROLL_TURN_COEFF * dt;
  }

  flightHeading = heading;

  // Reines Acro-Fliegen (alle drei Achsen vom Controller, siehe Kommentar
  // bei rotateAroundBodyAxes oben) läuft über Körperachsen-Rotation statt
  // heading/pitch/roll-Komposition, um den Gimbal bei kombiniertem
  // Pitch+Roll (schräger Looping) zu vermeiden.
  // Mit Controller läuft die Fluglage IMMER über den Acro-Pfad, solange keine
  // Tastatur-Achse aktiv ist. Früher musste dafür jede der drei Achsen schon
  // einmal per Stick bewegt worden sein (ControlSource === "controller") -
  // bis dahin lief der Euler-Pfad, und das Umschalten mitten im Flug war
  // eine Quelle für Sprünge.
  const fullAcroFlight =
    connectedGamepadIndex !== null &&
    pitchTargetKeyboard === 0 &&
    rollTargetKeyboard === 0 &&
    yawTargetKeyboard === 0;

  let acroDirection = null;
  let acroUp = null;
  if (fullAcroFlight) {
    pitchControlSource = "controller";
    rollControlSource = "controller";
    yawControlSource = "controller";
    if (!acroFlightValid || cameraChangedExternally) {
      // Einstieg in den Acro-Pfad (oder Ortssprung/Favorit/Pause-Ende):
      // Fluglage einmalig aus heading/pitch/roll (ohne Tilt) aufbauen.
      camera.setView({
        destination: camera.position,
        orientation: { heading, pitch, roll },
      });
      Cesium.Cartesian3.clone(camera.direction, acroFlightDirection);
      Cesium.Cartesian3.clone(camera.up, acroFlightUp);
      acroFlightValid = true;
    }
    acroDirection = acroFlightDirection;
    acroUp = acroFlightUp;
    rotateAroundBodyAxes(
      acroDirection,
      acroUp,
      controllerRate(rollTargetGamepad, CONTROLLER_RATES.roll),
      controllerRate(pitchTargetGamepad, CONTROLLER_RATES.pitch),
      // Minus: Cesium-Heading zählt positiv im Uhrzeigersinn (Rechtskurve),
      // die Rechte-Hand-Rotation um die Senkrechte dreht dagegen nach links.
      -yawTargetGamepad, // enthält die Yaw-Rate bereits (siehe oben)
      acroUp, // Körper-Hochachse statt Welt-Senkrechte (siehe Kommentar oben)
      dt,
      cameraTiltOffset * acroRollAxisBlend, // Roll um die Blickachse -> rechter Stick links/rechts = reines Rollen, kein scheinbares Gieren
    );
    setCameraPoseDirect(camera, camera.position, acroDirection, acroUp);
    // pitch/roll/flightHeading nur noch als abgeleitete Anzeigewerte (HUD,
    // Minimap, Favoriten-Speichern) nachführen - die Steuerung läuft rein
    // über acroFlightDirection/acroFlightUp weiter.
    pitch = camera.pitch;
    roll = camera.roll;
    pitchRaw = inverseSoftLimitAngle(
      pitch,
      PITCH_MAX,
      Cesium.Math.toRadians(PITCH_LIMIT_EASE_DEG),
    );
    rollRaw = inverseSoftLimitAngle(
      roll,
      ROLL_MAX,
      Cesium.Math.toRadians(ROLL_LIMIT_EASE_DEG),
    );
    flightHeading = camera.heading;
    heading = flightHeading;
  } else {
    acroFlightValid = false;
    camera.setView({
      destination: camera.position,
      orientation: { heading, pitch, roll },
    });
  }

  // --- Schwerkraft + Schub -------------------------------------------------
  // bodyUp ist die tatsächliche "Oben"-Achse der Drohne in Weltkoordinaten:
  // camera.up direkt nach dem obigen setView, also VOR dem weiter unten
  // angewandten kosmetischen cameraTiltOffset (der nur die Kamera fürs
  // Rendering verstellt, nicht die echte Fluglage). Kippt bei Pitch nach
  // vorne mit - siehe Kommentar beim Konstanten-Block oben.
  const bodyUp = Cesium.Cartesian3.clone(camera.up, new Cesium.Cartesian3());

  // Schwerkraft zeigt lokal nach unten (Ellipsoid-Normale an der aktuellen
  // Position, nicht Welt-Z - sonst stimmt die Richtung nur am Äquator).
  const localUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
    camera.positionWC,
    new Cesium.Cartesian3(),
  );

  if (keyboardFlight) {
    // Tastatur-Flug: Geschwindigkeit bleibt wie eingestellt und zeigt immer
    // in Flugrichtung (Heading + Flug-Pitch). Der Kamera-Blickwinkel
    // (cameraTiltOffset) wird erst danach aufs Rendering addiert und ändert
    // die Flugrichtung daher nicht.
    velocity = Cesium.Cartesian3.multiplyByScalar(
      camera.direction,
      keyboardSpeed,
      new Cesium.Cartesian3(),
    );
  } else {
    const accel = Cesium.Cartesian3.multiplyByScalar(
      bodyUp,
      throttle * THRUST_MAX_ACCEL,
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.subtract(
      accel,
      Cesium.Cartesian3.multiplyByScalar(
        localUp,
        GRAVITY_ACCEL,
        new Cesium.Cartesian3(),
      ),
      accel,
    );
    // Quadratischer statt linearer Luftwiderstand - siehe Kommentar bei
    // DRAG_COEFF_QUAD oben: bremst bei niedrigem Tempo kaum, erst nahe der
    // Grenzgeschwindigkeit spürbar.
    const speedForDrag = Cesium.Cartesian3.magnitude(velocity);
    Cesium.Cartesian3.subtract(
      accel,
      Cesium.Cartesian3.multiplyByScalar(
        velocity,
        DRAG_COEFF_QUAD * speedForDrag,
        new Cesium.Cartesian3(),
      ),
      accel,
    );

    Cesium.Cartesian3.add(
      velocity,
      Cesium.Cartesian3.multiplyByScalar(accel, dt, new Cesium.Cartesian3()),
      velocity,
    );
  }

  // Sicherheits-Cap, falls die Konstanten (z.B. beim Tunen) mal eine
  // unrealistisch hohe Geschwindigkeit zulassen würden.
  const speedRaw = Cesium.Cartesian3.magnitude(velocity);
  if (speedRaw > MAX_SPEED) {
    Cesium.Cartesian3.multiplyByScalar(
      velocity,
      MAX_SPEED / speedRaw,
      velocity,
    );
  }

  // Kollisionsprüfung: nur bei Bewegung, Reichweite = das, was ohnehin in
  // diesem Frame zurückgelegt würde, plus Sicherheitsabstand (siehe
  // Kommentar oben bei den Konstanten). Prüft jetzt entlang der
  // tatsächlichen Bewegungsrichtung (velocity), nicht mehr entlang der
  // Blickrichtung - beide können sich jetzt unterscheiden (z.B. im freien
  // Fall bei Level-Fluglage).
  let speed = Cesium.Cartesian3.magnitude(velocity);
  if (speed > 0) {
    const moveDirection = Cesium.Cartesian3.divideByScalar(
      velocity,
      speed,
      new Cesium.Cartesian3(),
    );
    const lookahead = Math.max(
      speed * dt + COLLISION_SAFETY_MARGIN,
      COLLISION_LOOKAHEAD_MIN,
    );
    const hitDistance = checkCollisionAhead(
      camera.positionWC,
      moveDirection,
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
        Cesium.Cartesian3.multiplyByScalar(moveDirection, speed, velocity);
      }
    } else {
      wasColliding = false;
    }
  } else {
    wasColliding = false;
  }

  // Kollisionsbremsung übernehmen, damit der Tastatur-Flug danach nicht
  // wieder auf die alte Geschwindigkeit springt.
  if (keyboardFlight) keyboardSpeed = speed;
  wasKeyboardFlight = keyboardFlight;

  updateFlightAudio({
    throttle,
    droneEnabled: !keyboardFlight,
    enabled: true,
  });

  if (speed !== 0) {
    const newPosition = Cesium.Cartesian3.add(
      camera.position,
      Cesium.Cartesian3.multiplyByScalar(velocity, dt, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    if (fullAcroFlight) {
      setCameraPoseDirect(camera, newPosition, acroDirection, acroUp);
    } else {
      camera.setView({
        destination: newPosition,
        orientation: { heading, pitch, roll },
      });
    }
  }

  // Kamera-Blickwinkel (FPV-Drohnen-Gimbal): erst NACHDEM sich die Position
  // entlang des normalen Flugpfads (unveränderter pitch/roll/heading)
  // bewegt hat, wird der zusätzliche Blickwinkel-Offset rein fürs Rendering
  // auf die tatsächliche Kamera-Ausrichtung addiert. Die Flugsteuerung
  // selbst (Bewegungsrichtung, pitch/roll-Variablen) bleibt unangetastet.
  if (cameraTiltOffset !== 0) {
    if (fullAcroFlight) {
      // Tilt nur auf Kopien - die Fluglage (acroFlightDirection/Up) bleibt tilt-frei.
      const tiltDirection = Cesium.Cartesian3.clone(acroDirection, acroTiltScratchDirection);
      const tiltUp = Cesium.Cartesian3.clone(acroUp, acroTiltScratchUp);
      applyRenderTiltToAxes(tiltDirection, tiltUp, cameraTiltOffset);
      setCameraPoseDirect(camera, camera.position, tiltDirection, tiltUp);
    } else {
      camera.setView({
        destination: camera.position,
        orientation: {
          heading,
          pitch: clampedRenderPitch(cameraTiltOffset),
          roll,
        },
      });
    }
  }

  // Endgültige Kameraausrichtung merken (für die Erkennung externer Änderungen).
  lastAppliedDirection = Cesium.Cartesian3.clone(camera.direction, lastAppliedDirection);
  lastAppliedUp = Cesium.Cartesian3.clone(camera.up, lastAppliedUp);

  // Geschwindigkeitsanzeige (HUD): m/s -> km/h
  speedEl.textContent = `${Math.round(speed * 3.6)} km/h`;

  // Höhenanzeige (HUD): Höhe über dem WGS84-Ellipsoid, nicht exakt über
  // Grund/Meeresspiegel, für einen Flugsimulator aber ausreichend genau.
  const altitude = Cesium.Cartographic.fromCartesian(camera.positionWC).height;
  altitudeEl.textContent = `${Math.round(altitude)} m`;

  updateMinimap();
  updateHorizon();
  updatePlaneModelMatrix();
  updateControllerDebugOverlay();
  updateStickOverlay();
  updateLocationBanner(now);
  updateDiscovery(now);
  pollDiscoveryAxis();
  pollScreenUiAxis();
  pollControllerButtons();

  // Position/Lage regelmäßig für den Reload-Fall sichern (siehe oben)
  if (now - lastSaveTime > SAVE_INTERVAL_MS) {
    saveCameraState();
    lastSaveTime = now;
  }
});
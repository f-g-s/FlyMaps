// Absturz-Log: hält fest, was kurz vor einem Render-/WebGL-Context-Fehler los
// war (Laufzeit, FPS, Tiles/GPU-Speicher, aktive Effekte, Position ...) und
// erkennt zusätzlich "unsaubere Enden" (Tab-Absturz ohne pagehide) per
// Heartbeat. Die Einträge liegen in localStorage und überleben damit den
// automatischen Reload; Anzeige/Kopieren/Löschen über das Menü.

const LOG_KEY = "flymaps_crash_log";
const HEARTBEAT_KEY = "flymaps_heartbeat"; // sessionStorage (pro Tab)
const MAX_ENTRIES = 30;
const MAX_RECENT_ERRORS = 5;
const HEARTBEAT_INTERVAL_MS = 5000;
const FRAME_SAMPLES = 120;

const KIND_LABELS = {
  crash: "Absturz (Render/Context)",
  "unclean-exit": "Unsauberes Ende (kein pagehide)",
};

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function readLog() {
  return safe(() => JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]"), []);
}

function writeLog(entries) {
  safe(() => localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES))));
}

function appendEntry(entry) {
  const entries = readLog();
  entries.push(entry);
  writeLog(entries);
}

function describeError(error) {
  if (!error) return null;
  if (typeof Event !== "undefined" && error instanceof Event) {
    return { type: error.type, statusMessage: error.statusMessage ?? null };
  }
  return {
    name: error.name ?? null,
    message: String(error.message ?? error),
    stack: String(error.stack ?? "").split("\n").slice(0, 6).join("\n"),
  };
}

function readGpuInfo(canvas) {
  return safe(() => {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return null;
    return {
      vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
      renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    };
  });
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(totalSec ?? 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} min`;
}

function formatEntry(e) {
  const s = e.snapshot ?? {};
  const t = s.tiles;
  const ef = s.effects;
  const when = new Date(e.at).toLocaleString("de-DE");
  const lines = [
    `${when} · ${KIND_LABELS[e.kind] ?? e.kind}${e.source ? ` (${e.source})` : ""} · Laufzeit ${formatDuration(e.uptimeSec)}`,
  ];
  if (e.error) lines.push(`  Fehler: ${e.error.message ?? e.error.type ?? "?"}`);
  if (e.frames) {
    lines.push(
      `  FPS Ø ${e.frames.avgFps ?? "?"} · schlechtester Frame ${e.frames.worstFrameMs ?? "?"} ms · letzter Frame vor ${e.frames.msSinceLastFrame ?? "?"} ms`,
    );
  }
  if (t) {
    lines.push(
      `  Tiles: ${t.loaded ?? "?"} geladen, ${t.pending ?? "?"} Requests offen, ${t.processing ?? "?"} in Verarbeitung · Tileset-Speicher ${t.memoryMb ?? "?"} MB (Geometrie ${t.geometryMb ?? "?"}, Texturen ${t.texturesMb ?? "?"})`,
    );
  }
  if (s.tileDetail) {
    lines.push(
      `  Tile-Detail: SSE ${s.tileDetail.maximumScreenSpaceError ?? "?"} · Cache ${s.tileDetail.cacheMb ?? "?"} MB (+${s.tileDetail.overflowMb ?? "?"} MB Overflow)`,
    );
  }
  if (e.heap) lines.push(`  JS-Heap ${e.heap.usedMb} / ${e.heap.limitMb} MB`);
  if (s.drawingBuffer) {
    lines.push(
      `  Render-Puffer ${s.drawingBuffer.w}×${s.drawingBuffer.h} (Skalierung ${s.drawingBuffer.resolutionScale}) · Minimap aktiv: ${s.minimapAlive ? "ja" : "nein"}`,
    );
  }
  if (ef) {
    const on = Object.entries(ef)
      .filter(([, v]) => v !== false && v !== 0)
      .map(([k, v]) => (v === true ? k : `${k}=${v}`));
    lines.push(`  Effekte: ${on.join(", ") || "keine"}`);
  }
  if (s.position) {
    lines.push(
      `  Position: ${s.position.lat}, ${s.position.lon}, ${s.position.heightM} m · ${s.speed ?? "?"}`,
    );
  }
  lines.push(
    `  Tab sichtbar: ${e.visibility ?? "?"}${e.focused === false ? " (ohne Fokus)" : ""} · GPU: ${e.env?.gpu?.renderer ?? "unbekannt"}`,
  );
  if (e.recentErrors?.length) {
    lines.push(`  Letzte Fehler: ${e.recentErrors.map((r) => r.message).join(" | ")}`);
  }
  return lines.join("\n");
}

export function initCrashLog({ viewer, getSnapshot }) {
  const env = {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: navigator.deviceMemory ?? null,
    gpu: readGpuInfo(viewer.canvas), // jetzt lesen, nach Context-Verlust nicht mehr möglich
  };

  // --- Frame-Statistik ---------------------------------------------------
  const frameTimes = [];
  let lastFrameAt = null;
  viewer.scene.postRender.addEventListener(() => {
    const now = performance.now();
    if (lastFrameAt !== null) {
      frameTimes.push(now - lastFrameAt);
      if (frameTimes.length > FRAME_SAMPLES) frameTimes.shift();
    }
    lastFrameAt = now;
  });

  function frameStats() {
    if (!frameTimes.length) return null;
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    return {
      avgFps: Math.round(1000 / avg),
      worstFrameMs: Math.round(Math.max(...frameTimes)),
      msSinceLastFrame: lastFrameAt === null ? null : Math.round(performance.now() - lastFrameAt),
    };
  }

  // --- Letzte (nicht fatale) Fehler -----------------------------------------
  const recentErrors = [];
  function pushRecentError(message) {
    recentErrors.push({ at: new Date().toISOString(), message: String(message).slice(0, 200) });
    if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
  }
  window.addEventListener("error", (ev) => pushRecentError(ev.message));
  window.addEventListener("unhandledrejection", (ev) =>
    pushRecentError(ev.reason?.message ?? ev.reason),
  );

  function buildEntry(kind, extra = {}) {
    const mem = safe(() => performance.memory);
    return {
      kind,
      at: new Date().toISOString(),
      uptimeSec: Math.round(performance.now() / 1000),
      visibility: document.visibilityState,
      focused: safe(() => document.hasFocus()),
      heap: mem
        ? {
            usedMb: Math.round(mem.usedJSHeapSize / 1048576),
            limitMb: Math.round(mem.jsHeapSizeLimit / 1048576),
          }
        : null,
      frames: frameStats(),
      recentErrors: [...recentErrors],
      env,
      snapshot: safe(getSnapshot),
      ...extra,
    };
  }

  // --- Heartbeat: erkennt Abstürze ohne Event (z.B. "Aw, Snap") ---------------
  const previous = safe(() => JSON.parse(sessionStorage.getItem(HEARTBEAT_KEY) ?? "null"));
  if (previous && previous.clean === false) {
    appendEntry({
      kind: "unclean-exit",
      at: new Date(previous.t).toISOString(),
      uptimeSec: previous.uptimeSec,
      visibility: previous.visibility,
      heap: previous.heap,
      frames: previous.frames,
      recentErrors: previous.recentErrors ?? [],
      env,
      snapshot: previous.snapshot,
    });
  }

  function writeHeartbeat(clean) {
    const base = buildEntry("heartbeat");
    safe(() =>
      sessionStorage.setItem(
        HEARTBEAT_KEY,
        JSON.stringify({
          t: Date.now(),
          clean,
          uptimeSec: base.uptimeSec,
          visibility: base.visibility,
          heap: base.heap,
          frames: base.frames,
          recentErrors: base.recentErrors,
          snapshot: base.snapshot,
        }),
      ),
    );
  }
  writeHeartbeat(false);
  setInterval(() => writeHeartbeat(false), HEARTBEAT_INTERVAL_MS);
  // Normales Neuladen/Schließen (auch unser eigener Recovery-Reload) hat
  // pagehide - fehlt es beim nächsten Start, war es ein harter Absturz.
  window.addEventListener("pagehide", () => writeHeartbeat(true));

  // --- Menü-Anbindung ---------------------------------------------------------
  const toggleBtn = document.getElementById("crash-log-toggle");
  const panel = document.getElementById("crash-log-panel");
  const output = document.getElementById("crash-log-output");
  const countEl = document.getElementById("crash-log-count");
  const copyBtn = document.getElementById("crash-log-copy");
  const clearBtn = document.getElementById("crash-log-clear");

  function refreshUi() {
    if (!toggleBtn) return;
    const entries = readLog();
    countEl.textContent = entries.length ? `(${entries.length})` : "";
    output.textContent = entries.length
      ? entries.slice().reverse().map(formatEntry).join("\n\n")
      : "Keine Einträge.";
  }

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggleBtn.textContent = panel.hidden ? "Anzeigen" : "Ausblenden";
      refreshUi();
      toggleBtn.blur();
    });
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(readLog(), null, 2));
        copyBtn.textContent = "Kopiert ✓";
      } catch {
        copyBtn.textContent = "Kopieren fehlgeschlagen";
      }
      setTimeout(() => (copyBtn.textContent = "Kopieren"), 1500);
      copyBtn.blur();
    });
    clearBtn.addEventListener("click", () => {
      writeLog([]);
      refreshUi();
      clearBtn.blur();
    });
    refreshUi();
  }

  return {
    // Synchron, damit der Eintrag vor dem Reload sicher geschrieben ist.
    recordCrash(source, error) {
      appendEntry(buildEntry("crash", { source, error: describeError(error) }));
    },
  };
}
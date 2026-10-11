// API-Key des Spielers: Ablage im localStorage und Eingabe-Dialog (#api-key-gate
// in index.html). Der Key verlässt den Browser nur in Richtung Google.
import { geocode } from "./geocode.js";

const STORAGE_KEY = "flymaps.googleApiKey";

// Nur lokale Entwicklung (vite dev): Key aus .env als Komfort. Im Produktions-
// Build ist import.meta.env.DEV false, dort gibt es keinen Standard-Key.
const DEV_KEY = import.meta.env.DEV
  ? import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  : undefined;

// Tastatureingaben im Dialog dürfen die Flugsteuerung (W, P, Esc, ...) nicht
// erreichen: die Handler hängen am window, daher hier im Dialog abfangen.
for (const type of ["keydown", "keyup", "keypress"]) {
  document
    .getElementById("api-key-gate")
    ?.addEventListener(type, (event) => event.stopPropagation());
}

export function getApiKey() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // localStorage kann z.B. im privaten Modus fehlschlagen
  }
  return DEV_KEY || null;
}

// Hat der Spieler im Dialog einen eigenen Key eingegeben (localStorage)?
export function hasStoredApiKey() {
  try {
    return Boolean(localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

function storeApiKey(key) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
    return true;
  } catch {
    return false;
  }
}

// Zeigt den Dialog und löst mit dem eingegebenen (und geprüften) Key auf.
// Mit cancellable: true gibt es "Abbrechen"; dann löst das Promise mit null auf.
// Der Key wird hier nur gespeichert, der Aufrufer entscheidet, was danach passiert.
export function requestApiKey({ error = "", cancellable = false } = {}) {
  const gate = document.getElementById("api-key-gate");
  const form = document.getElementById("api-key-form");
  const input = document.getElementById("api-key-input");
  const showToggle = document.getElementById("api-key-show");
  const errorEl = document.getElementById("api-key-error");
  const submitBtn = document.getElementById("api-key-submit");
  const cancelBtn = document.getElementById("api-key-cancel");

  errorEl.textContent = error;
  errorEl.hidden = !error;
  input.value = "";
  input.type = "password";
  showToggle.checked = false;
  cancelBtn.hidden = !cancellable;
  gate.hidden = false;
  input.focus();

  return new Promise((resolve) => {
    const close = (value) => {
      gate.hidden = true;
      form.removeEventListener("submit", onSubmit);
      showToggle.removeEventListener("change", onToggle);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(value);
    };
    const showError = (message) => {
      errorEl.textContent = message;
      errorEl.hidden = !message;
    };
    const onToggle = () => {
      input.type = showToggle.checked ? "text" : "password";
    };
    const onCancel = () => close(null);
    const onSubmit = async (event) => {
      event.preventDefault();
      const key = input.value.trim();
      if (key.length < 20 || /\s/.test(key)) {
        showError("Das sieht nicht nach einem API-Key aus (Google-Keys sind ca. 39 Zeichen lang, meist mit \"AIza\" am Anfang).");
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = "Prüfe Key…";
      try {
        // Schneller Test über die Geocoding API. Schlägt Google den Key aus,
        // bleibt der Dialog offen. Ein reiner Netzwerkfehler blockiert nicht -
        // ob die 3D-Tiles funktionieren, zeigt sich beim Laden.
        const result = await geocode({ q: "Berlin" }, key);
        if (result.status === "REQUEST_DENIED" || result.status === "OVER_QUERY_LIMIT") {
          showError(
            `Google lehnt den Key ab (${result.status}). ${result.error ?? ""} ` +
              "Prüfe, ob die Geocoding API und die Map Tiles API aktiviert sind, Abrechnung eingerichtet ist und der Key nicht auf eine HTTP-Referrer-Domain beschränkt ist.",
          );
          return;
        }
      } catch (err) {
        console.warn("Key-Test nicht möglich:", err);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Speichern und starten";
      }
      if (!storeApiKey(key)) {
        showError("Der Key konnte nicht im Browser gespeichert werden (privater Modus?).");
        return;
      }
      close(key);
    };

    form.addEventListener("submit", onSubmit);
    showToggle.addEventListener("change", onToggle);
    cancelBtn.addEventListener("click", onCancel);
  });
}

export function clearApiKey() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignorieren
  }
}
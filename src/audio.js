const DRONE_AUDIO_SRC = "/sounds/drone.mp3";
const MIN_PLAYBACK_RATE = 0.6;
const MAX_PLAYBACK_RATE = 1.5;
const MIN_VOLUME = 0.12;
const MAX_VOLUME = 1.5;
const WIND_AUDIO_SRC = "/sounds/wind.mp3";
const WIND_MIN_VOLUME = 0.4;
const WIND_MAX_VOLUME = 0.5;

const drone = {
  src: DRONE_AUDIO_SRC,
  buffer: undefined,
  source: undefined,
  gain: undefined,
  loadPromise: undefined,
  enabled: false,
  playbackRate: MIN_PLAYBACK_RATE,
  volume: MIN_VOLUME,
};
const wind = {
  src: WIND_AUDIO_SRC,
  buffer: undefined,
  source: undefined,
  gain: undefined,
  loadPromise: undefined,
  enabled: false,
  playbackRate: 1,
  volume: WIND_MIN_VOLUME,
};
const tracks = [drone, wind];

let audioContext;
let audioUnlocked = false;
let soundsEnabled = true;

function startTrack(track) {
  if (
    !soundsEnabled ||
    !audioUnlocked ||
    !track.enabled ||
    !track.buffer ||
    track.source
  ) return;

  const source = audioContext.createBufferSource();
  source.buffer = track.buffer;
  source.loop = true;
  source.playbackRate.value = track.playbackRate;
  source.connect(track.gain);
  track.gain.gain.value = track.volume;
  source.addEventListener(
    "ended",
    () => {
      if (track.source === source) track.source = undefined;
    },
    { once: true },
  );
  source.start();
  track.source = source;
}

async function loadTrack(track) {
  if (!track.loadPromise) {
    track.loadPromise = fetch(track.src)
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status} while loading ${track.src}`,
          );
        }
        return response.arrayBuffer();
      })
      .then((data) => audioContext.decodeAudioData(data))
      .then((buffer) => {
        track.buffer = buffer;
        startTrack(track);
      })
      .catch((error) => {
        track.loadPromise = undefined;
        throw error;
      });
  }

  try {
    await track.loadPromise;
  } catch (error) {
    console.error(`Flug-Sound konnte nicht geladen werden: ${track.src}`, error);
    throw error;
  }
}

async function unlockAudio() {
  audioUnlocked = true;

  try {
    if (!audioContext) {
      audioContext = new AudioContext();
      for (const track of tracks) {
        track.gain = audioContext.createGain();
        track.gain.gain.value = 0;
        track.gain.connect(audioContext.destination);
      }
    }

    await audioContext.resume();
    const results = await Promise.allSettled(tracks.map(loadTrack));
    if (
      audioContext.state === "running" &&
      results.every((result) => result.status === "fulfilled")
    ) {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    }
  } catch (error) {
    console.error("Flug-Sound konnte nicht gestartet werden.", error);
  }
}

window.addEventListener("pointerdown", unlockAudio);
window.addEventListener("keydown", unlockAudio);

export function setSoundsEnabled(enabled) {
  soundsEnabled = enabled;
  syncTracks();
}

export function updateFlightAudio({ throttle, droneEnabled, enabled }) {
  const throttleFactor = Math.min(Math.max(throttle, 0), 1);
  drone.enabled = enabled && droneEnabled;
  drone.playbackRate =
    MIN_PLAYBACK_RATE +
    throttleFactor * (MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE);
  drone.volume = MIN_VOLUME + throttleFactor * (MAX_VOLUME - MIN_VOLUME);
  wind.enabled = enabled;
  wind.volume =
    WIND_MIN_VOLUME + throttleFactor * (WIND_MAX_VOLUME - WIND_MIN_VOLUME);

  syncTracks();
}

function syncTracks() {
  for (const track of tracks) {
    const enabled = soundsEnabled && track.enabled;
    if (track.gain) {
      track.gain.gain.value = enabled ? track.volume : 0;
    }
    if (track.source) track.source.playbackRate.value = track.playbackRate;

    if (enabled) {
      startTrack(track);
    } else if (track.source) {
      track.source.stop();
      track.source.disconnect();
      track.source = undefined;
    }
  }
}

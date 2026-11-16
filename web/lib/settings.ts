/**
 * Session settings that survive a page reload.
 *
 * Stored as one JSON object in localStorage. Every field is validated on load, so a
 * stale or hand-edited value falls back to its default instead of breaking the form.
 */

export type InputModeSetting = "mic" | "file" | "batch";
export type DecodeProfileSetting = "realtime" | "accurate";

export interface PersistedSettings {
  inputMode: InputModeSetting;
  /** Recognition language code, or "auto" to let the engine detect it. */
  languageCode: string;
  /** Engine endpoint ID, or "" to let Core route the session. */
  engineHint: string;
  decodeProfile: DecodeProfileSetting;
  /** VAD speech probability threshold, VAD_THRESHOLD_RANGE. */
  vadThreshold: number;
  /** Seconds of silence that end an utterance, VAD_SILENCE_RANGE. */
  vadSilence: number;
  /** Send an uploaded file at 1× speed instead of as fast as possible. */
  realtimePacing: boolean;
}

export const SETTINGS_KEY = "speechmux_settings";

export const LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "auto", label: "Auto-detect" },
  { code: "ko", label: "Korean" },
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
];

export const VAD_THRESHOLD_RANGE = { min: 0.3, max: 0.95, step: 0.05 } as const;
export const VAD_SILENCE_RANGE = { min: 0.3, max: 3.0, step: 0.1 } as const;

export const DEFAULT_SETTINGS: PersistedSettings = {
  inputMode: "mic",
  languageCode: "ko",
  engineHint: "",
  decodeProfile: "realtime",
  // Match Core's default (stream.vad_threshold: 0.5). 0.65 classified low-energy syllables
  // as silence and let the EPD split utterances mid-word in end-to-end tests.
  vadThreshold: 0.5,
  vadSilence: 0.8,
  realtimePacing: true,
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function numberInRange(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * Parse a stored settings string. Unknown or invalid fields take their default;
 * a missing or corrupt string yields DEFAULT_SETTINGS.
 */
export function parseSettings(raw: string | null): PersistedSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_SETTINGS };
  }
  const stored = parsed as Record<string, unknown>;
  const { inputMode, languageCode, engineHint, decodeProfile, realtimePacing } = stored;
  return {
    inputMode:
      inputMode === "mic" || inputMode === "file" || inputMode === "batch"
        ? inputMode
        : DEFAULT_SETTINGS.inputMode,
    languageCode:
      typeof languageCode === "string" && LANGUAGE_OPTIONS.some((option) => option.code === languageCode)
        ? languageCode
        : DEFAULT_SETTINGS.languageCode,
    engineHint: typeof engineHint === "string" ? engineHint : DEFAULT_SETTINGS.engineHint,
    decodeProfile:
      decodeProfile === "realtime" || decodeProfile === "accurate"
        ? decodeProfile
        : DEFAULT_SETTINGS.decodeProfile,
    vadThreshold: numberInRange(stored["vadThreshold"], VAD_THRESHOLD_RANGE, DEFAULT_SETTINGS.vadThreshold),
    vadSilence: numberInRange(stored["vadSilence"], VAD_SILENCE_RANGE, DEFAULT_SETTINGS.vadSilence),
    realtimePacing: typeof realtimePacing === "boolean" ? realtimePacing : DEFAULT_SETTINGS.realtimePacing,
  };
}

/** Read the saved settings; defaults when storage is unavailable (private mode, SSR). */
export function loadSettings(storage?: StorageReader): PersistedSettings {
  try {
    return parseSettings((storage ?? window.localStorage).getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the settings. Storage failures (quota, private mode) are ignored. */
export function saveSettings(settings: PersistedSettings, storage?: StorageWriter): void {
  try {
    (storage ?? window.localStorage).setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not being able to remember settings must never break the session.
  }
}

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, parseSettings, saveSettings } from "./settings";

describe("parseSettings", () => {
  it("returns the defaults for a missing value", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults for corrupt JSON", () => {
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults for JSON that is not an object", () => {
    expect(parseSettings("[1,2,3]")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a full, valid settings object", () => {
    const stored = {
      inputMode: "file",
      languageCode: "en",
      engineHint: "faster-whisper",
      decodeProfile: "accurate",
      vadThreshold: 0.7,
      vadSilence: 1.5,
      realtimePacing: false,
    };
    expect(parseSettings(JSON.stringify(stored))).toEqual(stored);
  });

  it("fills in defaults for fields that are missing", () => {
    expect(parseSettings(JSON.stringify({ languageCode: "ja" }))).toEqual({
      ...DEFAULT_SETTINGS,
      languageCode: "ja",
    });
  });

  it("replaces unknown enum values with their defaults", () => {
    const parsed = parseSettings(
      JSON.stringify({ inputMode: "video", languageCode: "xx", decodeProfile: "turbo" }),
    );
    expect(parsed.inputMode).toBe(DEFAULT_SETTINGS.inputMode);
    expect(parsed.languageCode).toBe(DEFAULT_SETTINGS.languageCode);
    expect(parsed.decodeProfile).toBe(DEFAULT_SETTINGS.decodeProfile);
  });

  it("clamps numeric fields into their slider range", () => {
    const parsed = parseSettings(JSON.stringify({ vadThreshold: 5, vadSilence: -1 }));
    expect(parsed.vadThreshold).toBe(0.95);
    expect(parsed.vadSilence).toBe(0.3);
  });

  it("rejects values of the wrong type", () => {
    const parsed = parseSettings(
      JSON.stringify({ vadThreshold: "0.9", realtimePacing: "yes", engineHint: 7 }),
    );
    expect(parsed.vadThreshold).toBe(DEFAULT_SETTINGS.vadThreshold);
    expect(parsed.realtimePacing).toBe(DEFAULT_SETTINGS.realtimePacing);
    expect(parsed.engineHint).toBe(DEFAULT_SETTINGS.engineHint);
  });

  it("returns a fresh object each time so callers cannot mutate the defaults", () => {
    expect(parseSettings(null)).not.toBe(DEFAULT_SETTINGS);
  });
});

describe("loadSettings / saveSettings", () => {
  it("writes under SETTINGS_KEY and reads the same settings back", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
    };
    const settings = { ...DEFAULT_SETTINGS, inputMode: "batch" as const, vadSilence: 1.2 };
    saveSettings(settings, storage);
    expect(store.has(SETTINGS_KEY)).toBe(true);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it("falls back to the defaults when storage throws", () => {
    const storage = {
      getItem: (): string | null => {
        throw new Error("storage disabled");
      },
    };
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("swallows a failing write", () => {
    const storage = {
      setItem: (): void => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => saveSettings(DEFAULT_SETTINGS, storage)).not.toThrow();
  });
});

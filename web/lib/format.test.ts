import { describe, expect, it } from "vitest";
import { formatBytes, formatClock, formatDuration, pluralize, stripExtension } from "./format";

describe("formatClock", () => {
  it("shows minutes and zero-padded seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(9_999)).toBe("0:09");
    expect(formatClock(75_000)).toBe("1:15");
  });

  it("adds hours from one hour on", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });

  it("treats a negative duration as zero", () => {
    expect(formatClock(-500)).toBe("0:00");
  });
});

describe("formatDuration", () => {
  it("uses one decimal under a minute", () => {
    expect(formatDuration(5.64)).toBe("5.6 s");
    expect(formatDuration(0)).toBe("0.0 s");
  });

  it("uses minutes and seconds from a minute on", () => {
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(125.4)).toBe("2 min 5 s");
  });

  it("treats a negative length as zero", () => {
    expect(formatDuration(-1)).toBe("0.0 s");
  });
});

describe("formatBytes", () => {
  it("uses KB below one megabyte and never shows 0 KB", () => {
    expect(formatBytes(100)).toBe("1 KB");
    expect(formatBytes(194_676)).toBe("190 KB");
  });

  it("uses MB with one decimal from one megabyte on", () => {
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});

describe("pluralize", () => {
  it("picks the singular for exactly one", () => {
    expect(pluralize(1, "file")).toBe("1 file");
  });

  it("picks the plural otherwise", () => {
    expect(pluralize(0, "file")).toBe("0 files");
    expect(pluralize(3, "utterance")).toBe("3 utterances");
  });

  it("accepts an irregular plural", () => {
    expect(pluralize(2, "entry", "entries")).toBe("2 entries");
  });
});

describe("stripExtension", () => {
  it("removes only the last extension", () => {
    expect(stripExtension("talk.final.wav")).toBe("talk.final");
  });

  it("leaves names without an extension, and dotfiles, alone", () => {
    expect(stripExtension("recording")).toBe("recording");
    expect(stripExtension(".hidden")).toBe(".hidden");
  });
});

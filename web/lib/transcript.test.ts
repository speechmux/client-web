import { describe, expect, it } from "vitest";
import type { RecognitionResult } from "./speechmux-ws";
import {
  MAX_LINES,
  applyDone,
  applyResult,
  extractIncremental,
  finalTextLines,
  sealPartial,
  transcriptToText,
  type TranscriptLine,
} from "./transcript";

function result(overrides: Partial<RecognitionResult>): RecognitionResult {
  return {
    isFinal: false,
    text: "",
    committedText: "",
    unstableText: "",
    languageCode: "ko",
    engineName: "",
    startSec: 0,
    endSec: 0,
    ...overrides,
  };
}

function line(overrides: Partial<TranscriptLine>): TranscriptLine {
  return {
    id: "line",
    displayText: "",
    unstableText: "",
    languageCode: "ko",
    startSec: 0,
    endSec: 0,
    isFinal: true,
    engineName: "auto",
    wallTime: 0,
    ...overrides,
  };
}

describe("extractIncremental", () => {
  it("returns the whole text when there is no baseline", () => {
    expect(extractIncremental("  hello world ", "")).toBe("hello world");
  });

  it("returns an empty string for blank input", () => {
    expect(extractIncremental("   ", "hello")).toBe("");
  });

  it("strips a cumulative baseline prefix", () => {
    expect(extractIncremental("hello world again", "hello world")).toBe("again");
  });

  it("ignores trailing punctuation on the baseline", () => {
    expect(extractIncremental("hello world again", "hello world.")).toBe("again");
  });

  it("matches the baseline case-insensitively", () => {
    expect(extractIncremental("Hello World again", "hello world")).toBe("again");
  });

  it("strips a baseline found mid-string", () => {
    expect(extractIncremental("um hello world again", "hello world")).toBe("again");
  });

  it("returns the text unchanged when the baseline does not occur in it", () => {
    expect(extractIncremental("오늘 날씨가 좋네요", "안녕하세요")).toBe("오늘 날씨가 좋네요");
  });
});

describe("applyResult", () => {
  it("creates a partial line from the first partial result", () => {
    const lines = applyResult([], result({ committedText: "안녕", unstableText: "하세" }), "", "auto");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      displayText: "안녕",
      unstableText: "하세",
      isFinal: false,
      engineName: "auto",
    });
  });

  it("updates the live partial line in place, keeping its id and wall time", () => {
    const first = applyResult([], result({ unstableText: "안녕" }), "", "auto");
    const second = applyResult(first, result({ committedText: "안녕하세요", unstableText: "오늘" }), "", "auto");
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.wallTime).toBe(first[0]?.wallTime);
    expect(second[0]).toMatchObject({ displayText: "안녕하세요", unstableText: "오늘" });
  });

  it("promotes the partial line to final and clears its unstable text", () => {
    const partial = applyResult([], result({ unstableText: "안녕하세" }), "", "auto");
    const final = applyResult(
      partial,
      result({ isFinal: true, committedText: "안녕하세요.", endSec: 1.2, engineName: "faster_whisper" }),
      "",
      "auto",
    );
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      id: partial[0]?.id,
      displayText: "안녕하세요.",
      unstableText: "",
      isFinal: true,
      endSec: 1.2,
      engineName: "faster_whisper",
    });
  });

  it("appends a final that arrives without a preceding partial", () => {
    const existing = [line({ id: "a", displayText: "첫 문장" })];
    const lines = applyResult(
      existing,
      result({ isFinal: true, committedText: "둘째 문장", startSec: 2, endSec: 3 }),
      "",
      "sherpa-onnx",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      displayText: "둘째 문장",
      isFinal: true,
      startSec: 2,
      endSec: 3,
      engineName: "sherpa-onnx",
    });
  });

  it("shows only the text beyond the baseline for a cumulative final", () => {
    const lines = applyResult([], result({ isFinal: true, committedText: "hello world again" }), "hello world", "auto");
    expect(lines[0]?.displayText).toBe("again");
  });

  it("drops a duplicate final that adds nothing beyond the baseline", () => {
    const existing = [line({ id: "a", displayText: "hello world" })];
    const lines = applyResult(existing, result({ isFinal: true, committedText: "hello world" }), "hello world", "auto");
    expect(lines).toBe(existing);
  });

  it("falls back to `text` when a final carries no committed text", () => {
    const lines = applyResult([], result({ isFinal: true, text: "fallback" }), "", "auto");
    expect(lines[0]?.displayText).toBe("fallback");
  });

  it("caps the list at MAX_LINES + 1, dropping the oldest lines", () => {
    const existing = Array.from({ length: MAX_LINES + 1 }, (_, index) =>
      line({ id: `line-${index}`, displayText: `text ${index}` }),
    );
    const lines = applyResult(existing, result({ isFinal: true, committedText: "newest" }), "", "auto");
    expect(lines).toHaveLength(MAX_LINES + 1);
    expect(lines[0]?.id).toBe("line-1");
    expect(lines[lines.length - 1]?.displayText).toBe("newest");
  });
});

describe("applyDone", () => {
  it("promotes a trailing partial line to final", () => {
    const lines = applyDone([line({ isFinal: false, displayText: "끝", unstableText: "나지 않은" })]);
    expect(lines[0]).toMatchObject({ isFinal: true, displayText: "끝", unstableText: "" });
  });

  it("returns the same array when the last line is already final", () => {
    const lines = [line({ displayText: "done" })];
    expect(applyDone(lines)).toBe(lines);
  });

  it("returns the same array when there are no lines", () => {
    const lines: TranscriptLine[] = [];
    expect(applyDone(lines)).toBe(lines);
  });
});

describe("sealPartial", () => {
  it("promotes a trailing partial line to final, keeping its unstable tail", () => {
    const lines = sealPartial([
      line({ id: "a", displayText: "첫 문장" }),
      line({ id: "b", isFinal: false, displayText: "안녕하세요", unstableText: "오늘" }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ id: "b", isFinal: true, displayText: "안녕하세요 오늘", unstableText: "" });
  });

  it("keeps a line that has only unstable text", () => {
    const lines = sealPartial([line({ isFinal: false, displayText: "", unstableText: "안녕" })]);
    expect(lines[0]).toMatchObject({ isFinal: true, displayText: "안녕" });
  });

  it("drops a trailing partial line that has no text", () => {
    const kept = line({ id: "a", displayText: "첫 문장" });
    expect(sealPartial([kept, line({ id: "b", isFinal: false })])).toEqual([kept]);
  });

  it("returns the same array when the last line is already final", () => {
    const lines = [line({ displayText: "done" })];
    expect(sealPartial(lines)).toBe(lines);
  });
});

describe("transcript export", () => {
  const lines = [
    line({ id: "a", displayText: "첫 문장" }),
    line({ id: "b", displayText: "" }),
    line({ id: "c", displayText: "진행 중", isFinal: false }),
    line({ id: "d", displayText: "둘째 문장" }),
  ];

  it("keeps only final lines that carry text", () => {
    expect(finalTextLines(lines).map((entry) => entry.id)).toEqual(["a", "d"]);
  });

  it("joins the final lines one per row", () => {
    expect(transcriptToText(lines)).toBe("첫 문장\n둘째 문장");
  });

  it("is empty when nothing is final", () => {
    expect(transcriptToText([line({ isFinal: false, displayText: "partial" })])).toBe("");
  });
});

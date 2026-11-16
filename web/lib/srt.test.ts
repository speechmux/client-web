import { describe, expect, it } from "vitest";
import { formatSrt, toSrtTimestamp } from "./srt";

describe("toSrtTimestamp", () => {
  it("formats zero", () => {
    expect(toSrtTimestamp(0)).toBe("00:00:00,000");
  });

  it("formats hours, minutes, seconds and milliseconds", () => {
    expect(toSrtTimestamp(3661.25)).toBe("01:01:01,250");
  });

  it("truncates sub-millisecond precision like the CLI does", () => {
    expect(toSrtTimestamp(1.9999)).toBe("00:00:01,999");
  });

  it("clamps negative times to zero", () => {
    expect(toSrtTimestamp(-3)).toBe("00:00:00,000");
  });
});

describe("formatSrt", () => {
  it("numbers cues from 1 and separates them with a blank line", () => {
    const srt = formatSrt([
      { startSec: 0, endSec: 1.5, text: "안녕하세요." },
      { startSec: 2, endSec: 4.25, text: "오늘 날씨가 정말 좋네요" },
    ]);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\n안녕하세요.\n\n" +
        "2\n00:00:02,000 --> 00:00:04,250\n오늘 날씨가 정말 좋네요\n\n",
    );
  });

  it("assumes a one-second cue when the end is not after the start", () => {
    expect(formatSrt([{ startSec: 5, endSec: 0, text: "no end time" }])).toBe(
      "1\n00:00:05,000 --> 00:00:06,000\nno end time\n\n",
    );
  });

  it("skips blank cues without leaving a gap in the numbering", () => {
    const srt = formatSrt([
      { startSec: 0, endSec: 1, text: "   " },
      { startSec: 1, endSec: 2, text: "  kept  " },
    ]);
    expect(srt).toBe("1\n00:00:01,000 --> 00:00:02,000\nkept\n\n");
  });

  it("returns an empty string for no cues", () => {
    expect(formatSrt([])).toBe("");
  });
});

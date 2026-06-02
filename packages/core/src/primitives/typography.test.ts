import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEXT_STYLE,
  layoutLines,
  measureWidth,
  resolveStyle,
} from "./typography.js";

describe("resolveStyle", () => {
  it("returns defaults when given nothing", () => {
    expect(resolveStyle()).toEqual(DEFAULT_TEXT_STYLE);
  });

  it("merges a partial over the defaults", () => {
    expect(resolveStyle({ fontSize: 32 })).toEqual({ ...DEFAULT_TEXT_STYLE, fontSize: 32 });
  });
});

describe("measureWidth", () => {
  it("is zero for an empty string", () => {
    expect(measureWidth("")).toBe(0);
  });

  it("scales with glyph count under the metric model", () => {
    const style = { fontSize: 10, advanceRatio: 0.5, letterSpacing: 0 };
    // 4 glyphs * (0.5 * 10) = 20
    expect(measureWidth("abcd", style)).toBe(20);
  });

  it("adds letter spacing between glyphs only", () => {
    const style = { fontSize: 10, advanceRatio: 0.5, letterSpacing: 2 };
    // 3 glyphs * 5 + 2 gaps * 2 = 15 + 4 = 19
    expect(measureWidth("abc", style)).toBe(19);
  });
});

describe("layoutLines", () => {
  const style = { fontSize: 10, lineHeight: 1.5, advanceRatio: 0.5, letterSpacing: 0 };

  it("stacks lines by line height", () => {
    const boxes = layoutLines(["a", "bb"], { style });
    expect(boxes[0]?.y).toBe(0);
    expect(boxes[1]?.y).toBe(15); // 10 * 1.5
    expect(boxes[0]?.height).toBe(15);
  });

  it("left-aligns at x=0 by default", () => {
    const boxes = layoutLines(["abc"], { style });
    expect(boxes[0]?.x).toBe(0);
  });

  it("centers within the box width", () => {
    // width("ab") = 2 * 5 = 10; box 100 -> x = (100-10)/2 = 45
    const boxes = layoutLines(["ab"], { style, boxWidth: 100, align: "center" });
    expect(boxes[0]?.x).toBe(45);
  });

  it("right-aligns within the box width", () => {
    const boxes = layoutLines(["ab"], { style, boxWidth: 100, align: "right" });
    expect(boxes[0]?.x).toBe(90);
  });

  it("applies the vertical offset", () => {
    const boxes = layoutLines(["x"], { style, offsetY: 7 });
    expect(boxes[0]?.y).toBe(7);
  });
});

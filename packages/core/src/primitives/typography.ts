/**
 * Lightweight typography / text-layout primitives for @cymatic/core presets.
 *
 * The core renderer surface is shape-based (it has no glyph rasterizer), so
 * these helpers stay deliberately minimal: they describe *where* text would
 * sit, using an approximate monospace-style metric model. Presets and higher
 * layers (e.g. an overlay canvas) consume the layout; richer text rendering is
 * a downstream concern. Everything here is pure and Node-testable.
 */

/** Horizontal alignment of a text run within its box. */
export type TextAlign = "left" | "center" | "right";

/** A resolved text style with absolute (pixel) sizing. */
export interface TextStyle {
  /** Font size in pixels (the line's cap-to-baseline scale). */
  fontSize: number;
  /** Line height as a multiple of `fontSize`. */
  lineHeight: number;
  /** Letter spacing (tracking) in pixels, added between glyphs. */
  letterSpacing: number;
  /** Advance width of one glyph as a fraction of `fontSize` (metric model). */
  advanceRatio: number;
}

/** A sensible default style (approximate monospace metrics). */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 16,
  lineHeight: 1.2,
  letterSpacing: 0,
  advanceRatio: 0.6,
};

/** Merge a partial style over {@link DEFAULT_TEXT_STYLE}. */
export function resolveStyle(style: Partial<TextStyle> = {}): TextStyle {
  return { ...DEFAULT_TEXT_STYLE, ...style };
}

/**
 * Estimate the rendered width, in pixels, of a single line of `text` under
 * `style`. Uses the metric model (`advanceRatio * fontSize` per glyph, plus
 * `letterSpacing` between glyphs). Approximate but stable and deterministic.
 */
export function measureWidth(text: string, style: Partial<TextStyle> = {}): number {
  const s = resolveStyle(style);
  const glyphs = [...text];
  if (glyphs.length === 0) return 0;
  const advance = s.advanceRatio * s.fontSize;
  return glyphs.length * advance + (glyphs.length - 1) * s.letterSpacing;
}

/** The computed geometry of one laid-out line. */
export interface LineBox {
  text: string;
  /** Left edge (x) in pixels, after applying alignment within `boxWidth`. */
  x: number;
  /** Baseline-top (y) in pixels of this line. */
  y: number;
  /** Measured line width in pixels. */
  width: number;
  /** Line height in pixels (`fontSize * lineHeight`). */
  height: number;
}

/** Options controlling {@link layoutLines}. */
export interface LayoutOptions {
  style?: Partial<TextStyle>;
  /** Box width in pixels used for horizontal alignment. */
  boxWidth?: number;
  /** Horizontal alignment within the box. Default `"left"`. */
  align?: TextAlign;
  /** Top offset in pixels for the first line. Default `0`. */
  offsetY?: number;
}

/**
 * Lay out an array of text lines into positioned {@link LineBox}es, stacking
 * them vertically by line height and aligning each within `boxWidth`. Pure —
 * given the same inputs it always returns the same boxes.
 */
export function layoutLines(lines: readonly string[], opts: LayoutOptions = {}): LineBox[] {
  const s = resolveStyle(opts.style);
  const lineH = s.fontSize * s.lineHeight;
  const boxWidth = opts.boxWidth ?? 0;
  const align: TextAlign = opts.align ?? "left";
  const offsetY = opts.offsetY ?? 0;

  return lines.map((text, i) => {
    const width = measureWidth(text, s);
    let x = 0;
    if (align === "center") x = (boxWidth - width) / 2;
    else if (align === "right") x = boxWidth - width;
    return {
      text,
      x,
      y: offsetY + i * lineH,
      width,
      height: lineH,
    };
  });
}

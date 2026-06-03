/**
 * Public primitive surface for @cymatic/core.
 *
 * These are the building blocks presets compose from — easing & smoothing,
 * color & palettes, lightweight typography, and audio-feature bindings. They
 * are pure, backend-agnostic, and Node-testable; a preset built only from this
 * surface (plus the {@link Renderer}) can run on any backend.
 */

export type { EasingFn, EasingName } from "./easing.js";
export {
  linear,
  easeInQuad,
  easeOutQuad,
  easeInOutQuad,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInOutSine,
  easeOutExpo,
  easings,
  lerp,
  mapRange,
  Smoother,
  makeSmoother,
} from "./easing.js";

export type { Palette, PaletteName } from "./palette.js";
export {
  rgb,
  rgb255,
  hex,
  mixColor,
  withAlpha,
  palette,
  sample,
  sampleRamp,
  blendPalettes,
  sampleBlended,
  rotateHue,
  palettes,
  PALETTE_CATALOG,
  PALETTE_NAMES,
} from "./palette.js";

export type { TextAlign, TextStyle, LineBox, LayoutOptions } from "./typography.js";
export {
  DEFAULT_TEXT_STYLE,
  resolveStyle,
  measureWidth,
  layoutLines,
} from "./typography.js";

export type { BandName } from "./bindings.js";
export {
  band,
  bandAt,
  level,
  mapFeature,
  onBeat,
  BandSmoother,
  smoothBand,
} from "./bindings.js";

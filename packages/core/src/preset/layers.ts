/**
 * Layer / pass composition model for @cymatic/core presets.
 *
 * A {@link Layer} is a single render pass: it owns optional setup, resize, and
 * per-frame `draw` logic, drawing through the backend-agnostic {@link Renderer}.
 * A {@link LayerStack} composes layers in order — the first layer typically
 * clears the frame (via {@link Renderer.beginFrame}) and later layers draw on
 * top. {@link composePreset} turns a stack into a {@link Preset}, so authoring a
 * preset can be as simple as listing its layers.
 *
 * Layers never branch on the backend; they only use the {@link Renderer} surface
 * and the per-frame {@link LayerFrame} context.
 */

import type { AudioFeatureFrame } from "../audio/features.js";
import type { Renderer } from "../render/renderer.js";
import {
  definePreset,
  type DefinePresetInput,
  type Preset,
  type PresetContext,
  type PresetDefinition,
} from "./preset.js";

/** Per-frame context handed to each layer's {@link Layer.draw}. */
export interface LayerFrame {
  /** The renderer; an open frame is already in progress. */
  readonly renderer: Renderer;
  /** Current audio snapshot. */
  readonly features: AudioFeatureFrame;
  /** Elapsed time in seconds. */
  readonly time: number;
  /** Seconds since the previous frame. */
  readonly dt: number;
  /** Backing-store width in device pixels. */
  readonly width: number;
  /** Backing-store height in device pixels. */
  readonly height: number;
}

/** Resize info handed to {@link Layer.resize}. */
export interface LayerResize {
  width: number;
  height: number;
  dpr: number;
}

/**
 * A single composable render pass. All hooks are optional except {@link draw};
 * a layer that only draws needs nothing else. Layers are stateful instances.
 */
export interface Layer {
  /** Stable identifier, useful for debugging / introspection. */
  readonly id: string;
  /** One-time setup. */
  init?(ctx: PresetContext): void | Promise<void>;
  /** Backing store resized. */
  resize?(size: LayerResize): void;
  /** Draw this pass for the current frame. */
  draw(frame: LayerFrame): void;
  /** Release resources. */
  dispose?(): void;
}

/**
 * An ordered collection of {@link Layer}s. Drives each layer's lifecycle in
 * registration order. The stack does NOT itself open/close the renderer frame —
 * that is the host's (or {@link composePreset}'s) responsibility — so a stack can
 * be embedded inside a larger composition.
 */
export class LayerStack {
  private readonly layers: Layer[];

  constructor(layers: readonly Layer[] = []) {
    this.layers = [...layers];
  }

  /** Append a layer to the top of the stack. Returns the layer for chaining. */
  add(layer: Layer): Layer {
    this.layers.push(layer);
    return layer;
  }

  /** The layers, in draw order. */
  list(): readonly Layer[] {
    return this.layers;
  }

  /** Number of layers. */
  get size(): number {
    return this.layers.length;
  }

  /** Initialize every layer that defines `init`. */
  async init(ctx: PresetContext): Promise<void> {
    for (const layer of this.layers) {
      await layer.init?.(ctx);
    }
  }

  /** Forward a resize to every layer that defines `resize`. */
  resize(size: LayerResize): void {
    for (const layer of this.layers) {
      layer.resize?.(size);
    }
  }

  /** Draw every layer in order for the current frame. */
  draw(frame: LayerFrame): void {
    for (const layer of this.layers) {
      layer.draw(frame);
    }
  }

  /** Dispose every layer that defines `dispose`, in reverse order. */
  dispose(): void {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      this.layers[i]?.dispose?.();
    }
  }
}

/**
 * The layers for a composition: either a fixed list (shared across instances —
 * fine for stateless layers) or a factory invoked per `create()` (preferred
 * when layers hold per-instance state).
 */
export type LayerSource = readonly Layer[] | (() => readonly Layer[]);

/** Options for {@link composePreset}. */
export interface ComposeOptions extends Omit<DefinePresetInput, "create"> {
  /** The layers to compose, in draw order, or a factory that builds them. */
  layers: LayerSource;
  /**
   * Background color factory, evaluated each frame. The composed preset opens
   * the frame with this color before any layer draws, and closes it after. If
   * omitted, layers are responsible for opening/closing the frame themselves.
   */
  background?: (features: AudioFeatureFrame, time: number) => {
    r: number;
    g: number;
    b: number;
    a: number;
  };
}

/**
 * Compose a {@link PresetDefinition} from a list of layers. Each `create()`
 * builds a fresh {@link LayerStack} (so instances don't share layer state) and
 * wraps it in a {@link Preset} that, per frame, opens the renderer frame to the
 * configured `background`, draws every layer, then closes the frame.
 *
 * This is the high-leverage authoring path: a preset pack lists its passes and
 * gets a registry-ready definition with correct lifecycle wiring for free.
 */
export function composePreset(options: ComposeOptions): PresetDefinition {
  const { layers, background, ...meta } = options;

  return definePreset({
    ...meta,
    create(): Preset {
      const built = typeof layers === "function" ? layers() : layers;
      const stack = new LayerStack([...built]);
      let size: LayerResize = { width: 0, height: 0, dpr: 1 };
      let renderer: Renderer | null = null;

      return {
        async init(ctx: PresetContext): Promise<void> {
          renderer = ctx.renderer;
          size = { width: ctx.width, height: ctx.height, dpr: ctx.dpr };
          await stack.init(ctx);
        },
        resize(width: number, height: number, dpr: number): void {
          size = { width, height, dpr };
          stack.resize(size);
        },
        update(features: AudioFeatureFrame, time: number, dt: number): void {
          if (!renderer) {
            throw new Error("composePreset: update() called before init()");
          }
          const frame: LayerFrame = {
            renderer,
            features,
            time,
            dt,
            width: size.width,
            height: size.height,
          };
          if (background) {
            renderer.beginFrame(background(features, time));
            stack.draw(frame);
            renderer.endFrame();
          } else {
            stack.draw(frame);
          }
        },
        dispose(): void {
          stack.dispose();
          renderer = null;
        },
      };
    },
  });
}

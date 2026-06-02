import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
} from "react";

import { version as coreVersion } from "@cymatic/core";
import { allPresets } from "@cymatic/presets";
import { Visualizer, type VisualizerRef } from "@cymatic/react";
import type { Preset, PresetDefinition } from "@cymatic/core";

import { buildSnippet } from "./snippet.js";

const DOCS_URL = "https://github.com/coreyepstein/cymatic#readme";
const GITHUB_URL = "https://github.com/coreyepstein/cymatic";

/** The current audio input the gallery is feeding the visualizer. */
type InputMode =
  | { kind: "none" }
  | { kind: "mic" }
  | { kind: "file"; name: string; buffer: AudioBuffer };

/** Decode a dropped/picked file into an AudioBuffer using the Web Audio API. */
async function decodeFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Web Audio API is not available in this browser.");
  }
  const ctx = new AudioCtx();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    void ctx.close();
  }
}

/** Detect whether any GPU canvas backend is plausibly available. */
function hasRenderBackend(): boolean {
  if (typeof document === "undefined") return false;
  try {
    if ("gpu" in navigator) return true;
    const probe = document.createElement("canvas");
    const gl =
      probe.getContext("webgl2") ?? probe.getContext("webgl");
    return gl != null;
  } catch {
    return false;
  }
}

export function App(): JSX.Element {
  const presets = useMemo<readonly PresetDefinition[]>(() => allPresets, []);
  const [selectedId, setSelectedId] = useState<string>(
    () => presets[0]?.id ?? "",
  );
  const selectedDef = useMemo<PresetDefinition | undefined>(
    () => presets.find((p) => p.id === selectedId),
    [presets, selectedId],
  );

  // Build a fresh preset instance whenever the selection changes so switching
  // is live and stateful per preset (no reload).
  const preset = useMemo<Preset | null>(
    () => (selectedDef ? selectedDef.create() : null),
    [selectedDef],
  );

  const [input, setInput] = useState<InputMode>({ kind: "none" });
  const [inputError, setInputError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const vizRef = useRef<VisualizerRef>(null);

  const backendAvailable = useMemo(hasRenderBackend, []);

  const snippet = useMemo(
    () => buildSnippet(selectedId || "geometric.op-grid"),
    [selectedId],
  );

  const handleFile = useCallback(async (file: File) => {
    setInputError(null);
    try {
      const buffer = await decodeFile(file);
      setInput({ kind: "file", name: file.name, buffer });
    } catch (err) {
      setInputError(
        err instanceof Error
          ? `Could not decode "${file.name}": ${err.message}`
          : `Could not decode "${file.name}".`,
      );
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const useMic = useCallback(() => {
    setInputError(null);
    setInput({ kind: "mic" });
  }, []);

  const copySnippet = useCallback(() => {
    const done = (): void => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(snippet).then(done).catch(() => {
        /* clipboard blocked — silently ignore */
      });
    }
  }, [snippet]);

  // Surface a setup error from the engine without crashing. We poll the
  // imperative handle since the ref does not re-render. An engine error can come
  // from two very different places — the microphone (permission denied, no
  // device) or the renderer (WebGPU/WebGL initialization failed) — and they
  // need different messaging, so we watch for it on every input kind, not just
  // mic, and classify it below.
  const [engineError, setEngineError] = useState<Error | null>(null);
  useEffect(() => {
    setEngineError(null);
    const id = window.setInterval(() => {
      const err = vizRef.current?.error ?? null;
      if (err) setEngineError(err);
    }, 400);
    return () => window.clearInterval(id);
  }, [input]);

  // A mic failure is one of the standard getUserMedia DOMException names, or
  // only plausible when the user actually asked for the microphone. Anything
  // else surfacing from the engine is a renderer/initialization failure.
  const isMicError =
    engineError != null &&
    input.kind === "mic" &&
    (engineError.name === "NotAllowedError" ||
      engineError.name === "NotFoundError" ||
      engineError.name === "NotReadableError" ||
      engineError.name === "SecurityError" ||
      engineError.name === "OverconstrainedError" ||
      engineError.name === "AbortError" ||
      /microphone|getusermedia|permission|audio input/i.test(
        engineError.message,
      ));
  const isRendererError = engineError != null && !isMicError;

  const micActive = input.kind === "mic" && !engineError;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>cymatic</h1>
          <span className="tagline">a tasteful web audio visualizer</span>
        </div>
        <nav className="header-links">
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            Docs
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>

      <aside className="sidebar">
        <div className="sidebar-title">
          Presets · {presets.length}
        </div>
        <ul className="preset-list">
          {presets.map((def) => (
            <li key={def.id}>
              <button
                type="button"
                className={`preset-item${def.id === selectedId ? " active" : ""}`}
                aria-pressed={def.id === selectedId}
                onClick={() => setSelectedId(def.id)}
              >
                <span className="preset-name">{def.name}</span>
                <span className="preset-id">{def.id}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="stage">
        <div
          className={`canvas-wrap${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {selectedDef ? (
            <div className="preset-meta">
              <h2>{selectedDef.name}</h2>
              {selectedDef.description ? <p>{selectedDef.description}</p> : null}
              {selectedDef.tags && selectedDef.tags.length > 0 ? (
                <div className="tags">
                  {selectedDef.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {!backendAvailable ? (
            <div className="status-overlay">
              <div className="status-card error">
                <h3>No graphics backend available</h3>
                <p>
                  This browser does not expose WebGPU or WebGL, so the live
                  canvas cannot render. The preset catalog and install snippets
                  below still work — try a hardware-accelerated browser to see
                  cymatic in motion.
                </p>
              </div>
            </div>
          ) : preset ? (
            <>
              <Visualizer
                ref={vizRef}
                key={`${selectedId}:${input.kind === "file" ? input.name : input.kind}`}
                preset={preset}
                microphone={input.kind === "mic"}
                audioBuffer={input.kind === "file" ? input.buffer : undefined}
                ariaLabel={`${selectedDef?.name ?? "cymatic"} visualizer`}
              />
              {isMicError ? (
                <div className="status-overlay">
                  <div className="status-card error">
                    <h3>Microphone unavailable</h3>
                    <p>
                      {engineError?.message ||
                        "Microphone access was denied or is not available."}{" "}
                      You can still drop in an audio file to visualize instead.
                    </p>
                  </div>
                </div>
              ) : isRendererError ? (
                <div className="status-overlay">
                  <div className="status-card error">
                    <h3>Renderer unavailable</h3>
                    <p>
                      {engineError?.message ||
                        "The graphics renderer failed to initialize."}{" "}
                      The live canvas cannot render in this browser — try a
                      hardware-accelerated browser with WebGPU or WebGL enabled.
                    </p>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="status-overlay">
              <div className="status-card">
                <h3>No preset selected</h3>
                <p>Choose a preset from the list to begin.</p>
              </div>
            </div>
          )}
        </div>

        <div className="controls">
          <button
            type="button"
            className="btn"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose audio file
          </button>
          <button
            type="button"
            className={`btn${micActive ? " primary active" : " primary"}`}
            onClick={useMic}
          >
            {micActive ? "Microphone live" : "Use microphone"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className="visually-hidden"
            aria-label="Choose audio file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />

          <span className="input-status">
            {inputError ? (
              <>
                <span className="dot error" />
                {inputError}
              </>
            ) : engineError && input.kind === "mic" ? (
              <>
                <span className="dot error" />
                Mic blocked — drop a file instead
              </>
            ) : input.kind === "mic" ? (
              <>
                <span className="dot live" />
                Listening to microphone
              </>
            ) : input.kind === "file" ? (
              <>
                <span className="dot live" />
                Playing {input.name}
              </>
            ) : (
              <>
                <span className="dot" />
                Drop a track here, pick a file, or use the mic
              </>
            )}
          </span>
        </div>

        <div className="snippet">
          <div className="snippet-header">
            <h4>Install &amp; usage</h4>
            <button
              type="button"
              className={`copy-btn${copied ? " copied" : ""}`}
              onClick={copySnippet}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre>
            <code>{snippet}</code>
          </pre>
          <p
            style={{
              margin: "0 20px 16px",
              fontSize: "0.72rem",
              color: "var(--fg-faint)",
            }}
          >
            cymatic core {coreVersion}
          </p>
        </div>
      </section>
    </div>
  );
}
